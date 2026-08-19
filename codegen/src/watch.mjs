import path from "node:path";
import { spawn } from "node:child_process";
import chokidar from "chokidar";
import { generateProject } from "./project.mjs";
import { createReloadProxy, waitForUpstream } from "./proxy.mjs";

/**
 * Watch mode -- `marko-go generate --watch [--cmd=...] [--proxy=...] <dir>`.
 *
 * The cycle is deliberately the same one templ runs:
 *
 *     .marko changes -> regenerate whole project
 *                    -> restart --cmd child (kill the old process GROUP)
 *                    -> wait for the app to answer
 *                    -> broadcast `reload` to browsers on the proxy
 *
 * Two decisions worth stating:
 *
 *  - We always regenerate the *whole* project, never just the changed file.
 *    Compilation is milliseconds, and cross-file tag composition means a
 *    change to `ui-button.marko` can change the Go emitted for every caller.
 *    A partial rebuild would be quietly wrong.
 *
 *  - Regeneration is best-effort. A half-typed template must print its
 *    error and leave the watcher (and the last good .go files) alone.
 */

const DEBOUNCE_MS = 80;

/** Format a per-file line the same way one-shot generate does. */
function fileLine(root, outPath) {
  return `  ${path.relative(root, outPath)}`;
}

/**
 * Supervises the `--cmd` child.
 *
 * `detached: true` puts the child in its own process group so that killing
 * `-pid` takes down the whole tree. That matters for `go run .`: `go run`
 * spawns the compiled binary as a grandchild, and killing only `go run`
 * would orphan the server, leaving the port bound and the next restart
 * failing with "address already in use".
 */
export class ChildRunner {
  constructor(cmd, { cwd = process.cwd(), log = console.log } = {}) {
    this.cmd = cmd;
    this.cwd = cwd;
    this.log = log;
    /** @type {import("node:child_process").ChildProcess | null} */
    this.child = null;
  }

  /** Kill the current child's process group and wait for it to be gone. */
  async stop(signal = "SIGTERM") {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise((resolve) => child.once("exit", resolve));
    killGroup(child, signal);
    // If it ignores SIGTERM, escalate rather than hang the watcher forever.
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  }

  /** Kill any previous child, then start a fresh one. */
  async restart() {
    await this.stop();
    this.log(`marko-go: > ${this.cmd}`);
    this.child = spawn(this.cmd, {
      shell: true,
      cwd: this.cwd,
      stdio: "inherit",
      detached: true,
    });
    this.child.on("error", (err) => {
      console.error(`marko-go: failed to run --cmd: ${err.message}`);
    });
  }
}

function killGroup(child, signal) {
  try {
    // Negative pid == "the whole process group", which `detached` gave us.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Run one generate pass, printing templ-style output.
 *
 * @returns {Promise<boolean>} true when every template compiled
 */
async function regenerate(dir, { log = console.log, logError = console.error } = {}) {
  const root = path.resolve(dir);
  const { results, errors } = await generateProject(root, { bestEffort: true });

  for (const r of results) log(fileLine(root, r.outPath));

  if (errors.length) {
    for (const { markoPath, error } of errors) {
      logError(`marko-go: ${path.relative(root, markoPath)}: ${error.message}`);
    }
    logError(
      `marko-go: ${errors.length} template${errors.length === 1 ? "" : "s"} failed; keeping previous output`,
    );
    return false;
  }

  log(
    `marko-go: generated ${results.length} file${results.length === 1 ? "" : "s"} from ${root}`,
  );
  return true;
}

/**
 * Start watch mode. Resolves only when the watcher is shut down.
 *
 * @param {object} opts
 * @param {string} opts.dir directory to watch
 * @param {string} [opts.cmd] shell command to (re)start on every change
 * @param {string} [opts.proxy] app URL to reverse-proxy with live reload
 * @param {number} [opts.proxyPort]
 * @param {AbortSignal} [opts.signal] shut down without SIGINT (tests)
 * @param {() => void} [opts.onReady] called once the watcher is armed, i.e.
 *   once chokidar has finished its initial scan and a write is guaranteed to
 *   produce an event. Only tests need this; a human is slower than the scan.
 */
export async function watch({ dir, cmd, proxy, proxyPort = 7331, signal, onReady }) {
  const root = path.resolve(dir);

  // Initial full generate, in the same format one-shot mode prints.
  await regenerate(root);

  const runner = cmd ? new ChildRunner(cmd, { cwd: process.cwd() }) : null;
  let hub = null;
  let server = null;

  if (proxy) {
    ({ server, hub } = createReloadProxy({ target: proxy }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(proxyPort, resolve);
    });
    console.log("");
    console.log(`marko-go: proxying ${proxy}`);
    console.log(`marko-go: open http://localhost:${proxyPort}  <- use this URL`);
    console.log("");
  }

  if (runner) await runner.restart();
  if (proxy) {
    await waitForUpstream(proxy);
    hub?.broadcast();
  }

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (p) => /(^|[\\/])(node_modules|\.[^\\/]+)([\\/]|$)/.test(p),
  });

  // Debounce: editors write in bursts (temp file + rename + chmod), and a
  // "save all" touches many files at once. One rebuild per burst.
  let timer = null;
  let running = false;
  let queued = false;

  const onChange = (event, file) => {
    if (!file.endsWith(".marko")) return;
    console.log(`marko-go: ${event} ${path.relative(root, file)}`);
    if (timer) clearTimeout(timer);
    timer = setTimeout(cycle, DEBOUNCE_MS);
  };

  async function cycle() {
    timer = null;
    // A change landing mid-cycle must not start a second, overlapping
    // restart -- that is how children get orphaned. Queue it instead.
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const ok = await regenerate(root);
      if (!ok) return; // keep old binary running, keep watching
      if (runner) await runner.restart();
      if (proxy) {
        const up = await waitForUpstream(proxy);
        if (!up) console.error(`marko-go: ${proxy} did not come up within 10s`);
        hub?.broadcast();
      }
    } catch (err) {
      // Never let a watcher iteration take the process down.
      console.error(`marko-go: ${err?.message ?? err}`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        timer = setTimeout(cycle, DEBOUNCE_MS);
      }
    }
  }

  watcher.on("add", (f) => onChange("added", f));
  watcher.on("change", (f) => onChange("changed", f));
  watcher.on("unlink", (f) => onChange("removed", f));
  watcher.on("error", (err) => console.error(`marko-go: watcher: ${err.message}`));
  watcher.on("ready", () => {
    console.log(`marko-go: watching ${root} for changes (ctrl-c to stop)`);
    onReady?.();
  });

  await new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("\nmarko-go: shutting down");
      if (timer) clearTimeout(timer);
      await watcher.close();
      hub?.closeAll();
      server?.close();
      await runner?.stop();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    signal?.addEventListener("abort", shutdown, { once: true });
  });
}
