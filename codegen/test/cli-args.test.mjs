import { describe, expect, test } from "bun:test";
import { parseArgs, USAGE } from "../src/cli.mjs";

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
