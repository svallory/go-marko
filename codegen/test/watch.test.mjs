import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildRunner } from "../src/watch.mjs";

/**
 * Watch-mode integration. These tests drive real timers, a real filesystem
 * watcher, and real child processes, so every wait is polled with a generous
 * cap rather than a fixed sleep -- a fixed sleep is exactly what makes this
 * kind of test flaky on a loaded CI box.
 */

const cleanups = [];

afterEach(async () => {
  let fn;
  while ((fn = cleanups.pop())) await fn();
});

/** Poll `predicate` until truthy or `timeout` elapses. */
async function until(predicate, { timeout = 30_000, interval = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-watch-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "go.mod"), "module myapp\n\ngo 1.24\n");
  const ui = path.join(root, "ui");
  fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui, "hello.marko"), "<div>one</div>\n");
  return { root, ui };
}

describe("watch", () => {
  test("regenerates when a .marko file changes", async () => {
    const { ui } = tempProject();
    const { watch } = await import("../src/watch.mjs");

    // Run the watcher for real, then take it down with the signal the CLI
    // wires up. No --cmd and no --proxy: this test is about the loop.
    const ac = new AbortController();
    let armed;
    const ready = new Promise((r) => (armed = r));
    const done = watch({ dir: ui, signal: ac.signal, onReady: armed });
    cleanups.push(async () => {
      ac.abort();
      await done;
    });
    // Writing before chokidar finishes its initial scan can lose the event.
    await ready;

    const out = path.join(ui, "hello.marko.go");
    await until(() => fs.existsSync(out), { what: "initial generate" });
    expect(fs.readFileSync(out, "utf8")).toContain("one");

    fs.writeFileSync(path.join(ui, "hello.marko"), "<div>two</div>\n");
    await until(() => fs.readFileSync(out, "utf8").includes("two"), {
      what: "regenerate after change",
    });

    // A brand new template is picked up as well.
    fs.writeFileSync(path.join(ui, "extra.marko"), "<span>extra</span>\n");
    await until(() => fs.existsSync(path.join(ui, "extra.marko.go")), {
      what: "regenerate after add",
    });
  }, 90_000);

  test("a broken template does not kill the watcher", async () => {
    const { ui } = tempProject();
    const { watch } = await import("../src/watch.mjs");

    const ac = new AbortController();
    let armed;
    const ready = new Promise((r) => (armed = r));
    const done = watch({ dir: ui, signal: ac.signal, onReady: armed });
    cleanups.push(async () => {
      ac.abort();
      await done;
    });
    // Writing before chokidar finishes its initial scan can lose the event.
    await ready;

    const out = path.join(ui, "hello.marko.go");
    await until(() => fs.existsSync(out), { what: "initial generate" });
    const good = fs.readFileSync(out, "utf8");

    fs.writeFileSync(path.join(ui, "hello.marko"), "<div>${broken(\n");
    // Give the failing cycle time to run, then assert the old output stands.
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.readFileSync(out, "utf8")).toBe(good);

    // ...and the watcher is still live: fix it and it rebuilds.
    fs.writeFileSync(path.join(ui, "hello.marko"), "<div>recovered</div>\n");
    await until(() => fs.readFileSync(out, "utf8").includes("recovered"), {
      what: "recovery after a broken edit",
    });
  }, 90_000);
});

describe("ChildRunner", () => {
  test("restart kills the previous process group before starting a new one", async () => {
    const marker = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-child-")),
      "pid",
    );
    cleanups.push(() => fs.rmSync(path.dirname(marker), { recursive: true, force: true }));

    // `sh -c 'node ...'` gives us a grandchild: killing only the shell would
    // orphan it, which is the bug `detached` + kill(-pid) exists to prevent.
    const script = `node -e "require('fs').writeFileSync('${marker}', String(process.pid)); setInterval(()=>{}, 1000)"`;
    const runner = new ChildRunner(script, { log() {} });
    cleanups.push(() => runner.stop());

    await runner.restart();
    const firstPid = Number(
      await until(
        () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null),
        { what: "first child to start" },
      ),
    );
    expect(alive(firstPid)).toBe(true);

    fs.rmSync(marker);
    await runner.restart();
    const secondPid = Number(
      await until(
        () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null),
        { what: "second child to start" },
      ),
    );

    expect(secondPid).not.toBe(firstPid);
    // The grandchild of the first run must be gone, not orphaned.
    await until(() => !alive(firstPid), { what: "first grandchild to die" });

    await runner.stop();
    await until(() => !alive(secondPid), { what: "second grandchild to die" });
  }, 90_000);

  test("stop on a runner that never started is a no-op", async () => {
    await new ChildRunner("true", { log() {} }).stop();
  });
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
