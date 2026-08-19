import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, parseArgs, USAGE } from "../src/cli.mjs";

describe("parseArgs", () => {
  test("one-shot generate", () => {
    const o = parseArgs(["generate", "./ui"]);
    expect(o.error).toBeUndefined();
    expect(o.command).toBe("generate");
    expect(o.dir).toBe("./ui");
    expect(o.watch).toBe(false);
    expect(o.proxyPort).toBe(7331);
  });

  test("the full templ-parity command line", () => {
    const o = parseArgs([
      "generate",
      "--watch",
      "--proxy=http://localhost:8090",
      "--cmd=go run -buildvcs=false .",
      "./ui",
    ]);
    expect(o.error).toBeUndefined();
    expect(o.watch).toBe(true);
    expect(o.proxy).toBe("http://localhost:8090");
    expect(o.cmd).toBe("go run -buildvcs=false .");
    expect(o.dir).toBe("./ui");
  });

  test("accepts space-separated flag values too", () => {
    const o = parseArgs([
      "generate",
      "--watch",
      "--proxy",
      "http://localhost:8090",
      "--cmd",
      "go run .",
      "--proxy-port",
      "9000",
      "ui",
    ]);
    expect(o.error).toBeUndefined();
    expect(o.proxy).toBe("http://localhost:8090");
    expect(o.cmd).toBe("go run .");
    expect(o.proxyPort).toBe(9000);
    expect(o.dir).toBe("ui");
  });

  test("flags may precede or follow the directory", () => {
    const a = parseArgs(["generate", "./ui", "--watch"]);
    const b = parseArgs(["generate", "--watch", "./ui"]);
    expect(a.dir).toBe("./ui");
    expect(a.watch).toBe(true);
    expect(b).toEqual(a);
  });

  test("--proxy-port=<n>", () => {
    expect(parseArgs(["generate", "--watch", "--proxy-port=1234", "ui"]).proxyPort).toBe(
      1234,
    );
  });

  test("rejects a non-port --proxy-port", () => {
    expect(parseArgs(["generate", "--watch", "--proxy-port=nope", "ui"]).error).toMatch(
      /proxy-port/,
    );
    expect(parseArgs(["generate", "--watch", "--proxy-port=70000", "ui"]).error).toMatch(
      /proxy-port/,
    );
  });

  test("--proxy/--cmd without --watch is an error, not silently ignored", () => {
    expect(parseArgs(["generate", "--cmd=go run .", "ui"]).error).toMatch(/--watch/);
    expect(parseArgs(["generate", "--proxy=http://x", "ui"]).error).toMatch(/--watch/);
  });

  test("missing dir, missing command, unknown command", () => {
    expect(parseArgs(["generate"]).error).toMatch(/missing <dir>/);
    expect(parseArgs([]).error).toMatch(/missing command/);
    expect(parseArgs(["build", "ui"]).error).toMatch(/unknown command: build/);
  });

  test("unknown flag is reported", () => {
    expect(parseArgs(["generate", "--nope", "ui"]).error).toMatch(/unknown flag: --nope/);
  });

  test("extra positional is reported", () => {
    expect(parseArgs(["generate", "ui", "extra"]).error).toMatch(
      /unexpected argument: extra/,
    );
  });

  test("a flag missing its value is reported, not swallowed", () => {
    expect(parseArgs(["generate", "--watch", "ui", "--cmd"]).error).toMatch(
      /--cmd requires a value/,
    );
  });

  test("-h/--help short-circuits validation", () => {
    for (const flag of ["-h", "--help"]) {
      const o = parseArgs([flag]);
      expect(o.help).toBe(true);
      expect(o.error).toBeUndefined();
    }
  });

  test("help text covers both modes and the templ-style example", () => {
    expect(USAGE).toContain("marko-go generate [flags] <dir>");
    expect(USAGE).toContain("--watch");
    expect(USAGE).toContain("--proxy-port");
    expect(USAGE).toContain('--proxy="http://localhost:8090"');
    expect(USAGE).toContain('--cmd="go run -buildvcs=false ."');
  });
});

describe("batch mode error reporting", () => {
  /**
   * A generate root with two templates that fail and one that succeeds.
   * A batch run must name BOTH failures (relative to the generate root) and
   * exit non-zero -- reporting only the first would make fixing N templates
   * take N runs, and an unprefixed message gives no clue which file to open.
   */
  let root;
  let uiDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-cli-"));
    fs.writeFileSync(path.join(root, "go.mod"), "module myapp\n\ngo 1.24\n");
    uiDir = path.join(root, "ui");
    fs.mkdirSync(path.join(uiDir, "pages"), { recursive: true });
    fs.mkdirSync(path.join(uiDir, "tags"), { recursive: true });
    // The ternary has no Go expression equivalent -- a stable UnsupportedError.
    fs.writeFileSync(
      path.join(uiDir, "pages", "bad-one.marko"),
      "export interface Input { a: string }\n<div>${input.a ? 'y' : 'n'}</div>\n",
    );
    fs.writeFileSync(
      path.join(uiDir, "tags", "bad-two.marko"),
      "export interface Input { b: string }\n<span>${input.b ? 'y' : 'n'}</span>\n",
    );
    fs.writeFileSync(path.join(uiDir, "fine.marko"), "<p>ok</p>\n");
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** Run main(), capturing stdout/stderr rather than printing them. */
  async function run(argv) {
    const out = [];
    const err = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => err.push(a.join(" "));
    try {
      const code = await main(argv);
      return { code, out: out.join("\n"), err: err.join("\n") };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  test("every failing template is reported, each prefixed with its source path", async () => {
    const { code, err } = await run(["generate", uiDir]);
    expect(code).toBe(1);
    // Paths are relative to the generate root, and use the .marko SOURCE
    // name -- that's the file the user edits.
    expect(err).toContain("marko-go: pages/bad-one.marko:");
    expect(err).toContain("marko-go: tags/bad-two.marko:");
    expect(err).toContain("2 of 3 templates failed");
    // The underlying diagnostic (message + source location) survives the
    // prefixing rather than being replaced by it.
    expect(err).toMatch(/bad-one\.marko: unsupported .+ \(at \d+:\d+\)/);
    expect(err).toMatch(/bad-two\.marko: unsupported .+ \(at \d+:\d+\)/);
  });

  test("the good template is still generated and listed", async () => {
    const { out } = await run(["generate", uiDir]);
    expect(out).toContain("fine.marko.go");
    expect(fs.existsSync(path.join(uiDir, "fine.marko.go"))).toBe(true);
    // The failing ones leave no partial output behind.
    expect(fs.existsSync(path.join(uiDir, "pages", "bad-one.marko.go"))).toBe(false);
  });

  test("an all-good project exits 0 with the summary line", async () => {
    fs.rmSync(path.join(uiDir, "pages"), { recursive: true });
    fs.rmSync(path.join(uiDir, "tags"), { recursive: true });
    const { code, out, err } = await run(["generate", uiDir]);
    expect(code).toBe(0);
    expect(out).toContain("marko-go: generated 1 file from");
    expect(err).toBe("");
  });

  test("a non-template failure (no go.mod) still exits 1 with a message", async () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-orphan-"));
    try {
      const { code, err } = await run(["generate", orphan]);
      expect(code).toBe(1);
      expect(err).toMatch(/no go\.mod found/);
    } finally {
      fs.rmSync(orphan, { recursive: true, force: true });
    }
  });
});
