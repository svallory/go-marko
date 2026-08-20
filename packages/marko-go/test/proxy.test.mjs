import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import zlib from "node:zlib";
import {
  RELOAD_PATH,
  RELOAD_SCRIPT,
  ReloadHub,
  createReloadProxy,
  injectReloadScript,
  isHtmlContentType,
  waitForUpstream,
} from "../src/proxy.mjs";

describe("injectReloadScript", () => {
  test("splices before </body>", () => {
    const out = injectReloadScript("<html><body><h1>hi</h1></body></html>", "<s/>");
    expect(out).toBe("<html><body><h1>hi</h1><s/></body></html>");
  });

  test("is case-insensitive about the closing tag", () => {
    expect(injectReloadScript("<BODY>x</BODY>", "<s/>")).toBe("<BODY>x<s/></BODY>");
  });

  test("uses the LAST </body> when the markup contains the text earlier", () => {
    const html = "<body><pre>&lt;/body&gt;</pre></body>";
    expect(injectReloadScript(html, "<s/>").endsWith("<s/></body>")).toBe(true);
  });

  test("falls back to </html> when there is no body tag", () => {
    expect(injectReloadScript("<html>x</html>", "<s/>")).toBe("<html>x<s/></html>");
  });

  test("appends when the response is a bare fragment", () => {
    expect(injectReloadScript("<div>x</div>", "<s/>")).toBe("<div>x</div><s/>");
  });

  test("the default script opens an EventSource on the reload path", () => {
    expect(RELOAD_SCRIPT).toContain("EventSource");
    expect(RELOAD_SCRIPT).toContain(RELOAD_PATH);
    expect(RELOAD_SCRIPT).toContain("location.reload");
  });
});

describe("isHtmlContentType", () => {
  test.each([
    ["text/html", true],
    ["text/html; charset=utf-8", true],
    ["TEXT/HTML;charset=UTF-8", true],
    ["text/plain", false],
    ["application/json", false],
    ["text/htmlish", false],
    ["image/png", false],
    [undefined, false],
    ["", false],
  ])("%p -> %p", (ct, expected) => {
    expect(isHtmlContentType(ct)).toBe(expected);
  });
});

describe("ReloadHub", () => {
  test("broadcast writes a named SSE event to every client", () => {
    const hub = new ReloadHub();
    const writes = [];
    const fake = () => ({
      writeHead() {},
      write(chunk) {
        writes.push(chunk);
      },
      on() {},
    });
    hub.add(fake());
    hub.add(fake());
    expect(hub.size).toBe(2);

    writes.length = 0;
    hub.broadcast();
    expect(writes).toEqual(["event: reload\ndata: 1\n\n", "event: reload\ndata: 1\n\n"]);
  });

  test("drops a client whose write throws (browser tab closed mid-broadcast)", () => {
    const hub = new ReloadHub();
    // Connects fine, then dies before the broadcast lands.
    let connected = false;
    hub.add({
      writeHead() {},
      write() {
        if (connected) throw new Error("EPIPE");
        connected = true;
      },
      on() {},
    });
    expect(hub.size).toBe(1);

    hub.broadcast();
    expect(hub.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * End-to-end: a fake "Go app" behind the real proxy.
 * ------------------------------------------------------------------ */

let app; // upstream
let appPort;
let proxy;
let proxyPort;
let hub;

/** Minimal fetch that also hands back raw headers. */
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  app = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // Deliberately split so `</body>` straddles a chunk boundary: an
      // injector that worked chunk-by-chunk would miss it.
      res.write("<html><body><h1>hello</h1></bo");
      res.end("dy></html>");
      return;
    }
    if (req.url === "/assets/app.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("body{color:red}");
    } else if (req.url === "/assets/logo.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    } else if (req.url === "/gzip") {
      // Only compresses when the client asked; the proxy must not ask.
      const asked = /gzip/.test(req.headers["accept-encoding"] || "");
      const body = "<html><body>gz</body></html>";
      if (asked) {
        res.writeHead(200, {
          "content-type": "text/html",
          "content-encoding": "gzip",
        });
        res.end(zlib.gzipSync(body));
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(body);
      }
    } else if (req.url === "/echo-accept-encoding") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(String(req.headers["accept-encoding"] ?? "<none>"));
    } else {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>nope</body></html>");
    }
  });
  await new Promise((r) => app.listen(0, r));
  appPort = app.address().port;

  ({ server: proxy, hub } = createReloadProxy({
    target: `http://127.0.0.1:${appPort}`,
  }));
  await new Promise((r) => proxy.listen(0, r));
  proxyPort = proxy.address().port;
});

afterAll(async () => {
  hub?.closeAll();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => app.close(r));
});

describe("reload proxy", () => {
  test("injects the script into HTML split across chunks", async () => {
    const res = await get(proxyPort, "/");
    const body = res.body.toString();
    expect(res.status).toBe(200);
    expect(body).toContain("<h1>hello</h1>");
    expect(body).toContain("EventSource");
    expect(body.indexOf("EventSource")).toBeLessThan(body.indexOf("</body>"));
  });

  test("recalculates content-length after injecting", async () => {
    const res = await get(proxyPort, "/");
    expect(res.headers["content-length"]).toBe(String(res.body.length));
    expect(res.headers["transfer-encoding"]).toBeUndefined();
  });

  test("injects into error pages too, so a 404 still live-reloads", async () => {
    const res = await get(proxyPort, "/missing");
    expect(res.status).toBe(404);
    expect(res.body.toString()).toContain("EventSource");
  });

  test("passes non-HTML through byte-for-byte", async () => {
    const css = await get(proxyPort, "/assets/app.css");
    expect(css.headers["content-type"]).toBe("text/css");
    expect(css.body.toString()).toBe("body{color:red}");
    expect(css.body.toString()).not.toContain("EventSource");

    const png = await get(proxyPort, "/assets/logo.png");
    expect([...png.body]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  });

  test("strips accept-encoding upstream so HTML is never gzipped", async () => {
    const echoed = await get(proxyPort, "/echo-accept-encoding", {
      "accept-encoding": "gzip, deflate, br",
    });
    expect(echoed.body.toString()).toBe("<none>");

    const gz = await get(proxyPort, "/gzip", { "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBeUndefined();
    expect(gz.body.toString()).toContain("EventSource");
  });

  test("serves an SSE stream on the reload path and broadcasts to it", async () => {
    const received = await new Promise((resolve, reject) => {
      const req = http.request({ port: proxyPort, path: RELOAD_PATH }, (res) => {
        expect(res.headers["content-type"]).toBe("text/event-stream");
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          if (buf.includes("event: reload")) {
            req.destroy();
            resolve(buf);
          }
        });
        // The stream is open once the first comment arrives; only then can
        // a broadcast reach it.
        res.once("data", () => setTimeout(() => hub.broadcast(), 10));
      });
      req.on("error", (e) => {
        if (e.code !== "ECONNRESET") reject(e);
      });
      req.end();
      setTimeout(() => reject(new Error("no reload event within 5s")), 5000);
    });

    expect(received).toContain(": connected");
    expect(received).toContain("event: reload\ndata: 1");
  }, 10_000);

  test("serves a self-reloading 502 page when the app is down", async () => {
    const { server: orphan } = createReloadProxy({
      // Nothing listens here.
      target: "http://127.0.0.1:1",
    });
    await new Promise((r) => orphan.listen(0, r));
    const res = await get(orphan.address().port, "/");
    expect(res.status).toBe(502);
    expect(res.body.toString()).toContain("upstream unavailable");
    expect(res.body.toString()).toContain("EventSource");
    await new Promise((r) => orphan.close(r));
  });
});

describe("waitForUpstream", () => {
  test("resolves true once the app answers", async () => {
    expect(await waitForUpstream(`http://127.0.0.1:${appPort}`)).toBe(true);
  });

  test("resolves false (not throws) when nothing is listening", async () => {
    expect(
      await waitForUpstream("http://127.0.0.1:1", { timeoutMs: 300, intervalMs: 50 }),
    ).toBe(false);
  }, 5000);
});
