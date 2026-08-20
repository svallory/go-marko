import http from "node:http";
import { Buffer } from "node:buffer";

/**
 * The live-reload proxy.
 *
 * `marko-go generate --watch --proxy=<app url>` puts this in front of the Go
 * app. It is a plain `node:http` reverse proxy -- no dependency -- whose only
 * job is to (a) make the browser hold an EventSource we can poke after a
 * rebuild, and (b) splice the client script into HTML responses so the page
 * itself does the reloading.
 *
 * Everything that is not HTML streams through byte-for-byte.
 */

/** Path the injected script connects to. Namespaced so it cannot collide. */
export const RELOAD_PATH = "/_marko-go/reload";

/**
 * The script spliced into every HTML page. Kept deliberately tiny and
 * dependency-free: one EventSource, one `location.reload()`.
 *
 * The `onerror` retry is what makes the DX feel right -- while the Go server
 * is restarting the proxy may be unreachable, and the browser reconnects on
 * its own instead of the user having to refresh manually.
 */
export const RELOAD_SCRIPT = `<script data-marko-go-reload>
(function () {
  if (window.__markoGoReload) return;
  window.__markoGoReload = true;
  function connect() {
    var es = new EventSource(${JSON.stringify(RELOAD_PATH)});
    es.addEventListener("reload", function () { window.location.reload(); });
    es.onerror = function () { es.close(); setTimeout(connect, 500); };
  }
  connect();
})();
</script>`;

/**
 * Splice `script` in just before the last `</body>` (case-insensitive).
 *
 * Falls back to `</html>`, and finally to appending, so a fragment response
 * or a document with no body tag still gets the reloader rather than being
 * silently left un-live.
 *
 * @param {string} html
 * @param {string} [script]
 * @returns {string}
 */
export function injectReloadScript(html, script = RELOAD_SCRIPT) {
  for (const tag of ["</body>", "</html>"]) {
    const idx = html.toLowerCase().lastIndexOf(tag);
    if (idx !== -1) return html.slice(0, idx) + script + html.slice(idx);
  }
  return html + script;
}

/** True when a Content-Type header names an HTML document. */
export function isHtmlContentType(contentType) {
  return /^\s*text\/html\b/i.test(contentType || "");
}

/**
 * Fan-out of `reload` events to every connected browser.
 *
 * Kept separate from the proxy server so it is unit-testable and so the
 * watcher can broadcast without knowing anything about HTTP.
 */
export class ReloadHub {
  constructor() {
    /** @type {Set<import("node:http").ServerResponse>} */
    this.clients = new Set();
  }

  get size() {
    return this.clients.size;
  }

  /** Turn `res` into an open SSE stream and remember it. */
  add(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // A first comment flushes headers immediately, so `curl -N` (and the
    // browser's EventSource) sees the connection open right away.
    res.write(": connected\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
    return res;
  }

  /** Send a named event with no payload to every client. */
  broadcast(event = "reload") {
    for (const res of this.clients) {
      try {
        res.write(`event: ${event}\ndata: 1\n\n`);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** End every open stream (used on shutdown). */
  closeAll() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }
}

/**
 * Create (but do not start) the reload proxy.
 *
 * @param {object} opts
 * @param {string} opts.target upstream app URL, e.g. http://localhost:8090
 * @param {ReloadHub} [opts.hub]
 * @returns {{server: import("node:http").Server, hub: ReloadHub}}
 */
export function createReloadProxy({ target, hub = new ReloadHub() }) {
  const upstream = new URL(target);

  const server = http.createServer((req, res) => {
    if (req.url === RELOAD_PATH || req.url?.startsWith(RELOAD_PATH + "?")) {
      hub.add(res);
      return;
    }

    const headers = { ...req.headers, host: upstream.host };
    // Strip accept-encoding so the upstream answers in plain text: we have to
    // read HTML to inject into it, and refusing compression is both simpler
    // and more correct than decompressing/recompressing on a dev proxy.
    delete headers["accept-encoding"];

    const proxyReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => {
        const outHeaders = { ...proxyRes.headers };

        if (!isHtmlContentType(proxyRes.headers["content-type"])) {
          // Not HTML: pipe through untouched, headers and all.
          res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
          proxyRes.pipe(res);
          return;
        }

        // HTML: buffer the whole body first. Injecting into a stream would
        // break whenever `</body>` straddles a chunk boundary, and we need
        // the final length to fix up content-length anyway.
        const chunks = [];
        proxyRes.on("data", (c) => chunks.push(c));
        proxyRes.on("end", () => {
          const body = injectReloadScript(Buffer.concat(chunks).toString("utf8"));
          const buf = Buffer.from(body, "utf8");
          delete outHeaders["content-length"];
          delete outHeaders["transfer-encoding"];
          outHeaders["content-length"] = String(buf.length);
          res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          res.end(buf);
        });
      },
    );

    proxyReq.on("error", (err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(
        injectReloadScript(
          `<!doctype html><html><body><h1>marko-go: upstream unavailable</h1>` +
            `<p>${escapeHtml(target)} -- ${escapeHtml(err.message)}</p>` +
            `<p>This page reloads itself once the app is back.</p></body></html>`,
        ),
      );
    });

    req.pipe(proxyReq);
  });

  return { server, hub };
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/**
 * Poll `target` until it answers (any HTTP status counts -- a 404 still means
 * the server is listening), or `timeoutMs` elapses.
 *
 * @returns {Promise<boolean>} true if the app came up in time
 */
export function waitForUpstream(target, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const url = new URL(target);

  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 80,
          method: "HEAD",
          path: "/",
          timeout: 1000,
        },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      const retry = () => {
        req.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, intervalMs);
      };
      req.on("error", retry);
      req.on("timeout", retry);
      req.end();
    };
    attempt();
  });
}
