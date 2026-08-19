import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateProject } from "../src/project.mjs";
import { UnsupportedError } from "../src/errors.mjs";

/**
 * Regression guard on the SHAPE of what generateProject returns.
 *
 * cli.mjs prints `path.relative(root, r.outPath)` for every result, so a
 * result entry that is undefined -- or one missing outPath -- crashes the
 * summary printer even though the .marko.go on disk is perfectly fine. That
 * failure mode is easy to reintroduce whenever the generate loop is
 * refactored, and a single-template directory is where it hides (one entry,
 * no neighbour to make the mistake obvious).
 */

const dirs = [];

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-shape-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "go.mod"), "module myapp\n\ngo 1.24\n");
  const ui = path.join(root, "ui");
  for (const [rel, source] of Object.entries(files)) {
    const full = path.join(ui, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  return { root, ui };
}

afterEach(() => {
  let d;
  while ((d = dirs.pop())) fs.rmSync(d, { recursive: true, force: true });
});

const HELLO = `<div>hello</div>\n`;

describe("generateProject result shape", () => {
  test("a single-template directory returns one fully-populated entry", async () => {
    const { ui } = fixture({ "hello.marko": HELLO });
    const results = await generateProject(ui);

    expect(results).toHaveLength(1);
    for (const r of results) {
      expect(r).toBeDefined();
      expect(typeof r.outPath).toBe("string");
      expect(typeof r.markoPath).toBe("string");
      expect(typeof r.code).toBe("string");
    }
    // The exact operation cli.mjs performs on every entry.
    expect(results.map((r) => path.relative(ui, r.outPath))).toEqual([
      "hello.marko.go",
    ]);
    expect(fs.existsSync(path.join(ui, "hello.marko.go"))).toBe(true);
  });

  test("every entry is populated for a multi-template directory too", async () => {
    const { ui } = fixture({
      "hello.marko": HELLO,
      "nested/bye.marko": `<div>bye</div>\n`,
    });
    const results = await generateProject(ui);

    expect(results).toHaveLength(2);
    expect(results.some((r) => r === undefined)).toBe(false);
    expect(results.map((r) => path.relative(ui, r.outPath)).sort()).toEqual([
      "hello.marko.go",
      "nested/bye.marko.go",
    ]);
  });

  test("write:false still returns populated entries and touches no disk", async () => {
    const { ui } = fixture({ "hello.marko": HELLO });
    const results = await generateProject(ui, { write: false });

    expect(results).toHaveLength(1);
    expect(results[0].outPath).toBe(path.join(ui, "hello.marko.go"));
    expect(results[0].code).toContain("package ui");
    expect(fs.existsSync(path.join(ui, "hello.marko.go"))).toBe(false);
  });
});

describe("bestEffort (watch mode)", () => {
  const BROKEN = `<div>\n  \${broken(\n</div>\n`;

  test("collects per-file errors instead of throwing, and keeps the good files", async () => {
    const { ui } = fixture({ "ok.marko": HELLO, "bad.marko": BROKEN });
    const { results, errors } = await generateProject(ui, { bestEffort: true });

    expect(errors).toHaveLength(1);
    expect(errors[0].markoPath).toBe(path.join(ui, "bad.marko"));
    expect(errors[0].error).toBeInstanceOf(Error);

    expect(results).toHaveLength(1);
    expect(results[0].outPath).toBe(path.join(ui, "ok.marko.go"));
    expect(fs.existsSync(path.join(ui, "ok.marko.go"))).toBe(true);
  });

  test("a previously generated file survives a later broken edit", async () => {
    const { ui } = fixture({ "hello.marko": HELLO });
    await generateProject(ui);
    const good = fs.readFileSync(path.join(ui, "hello.marko.go"), "utf8");

    fs.writeFileSync(path.join(ui, "hello.marko"), BROKEN);
    const { results, errors } = await generateProject(ui, { bestEffort: true });

    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(fs.readFileSync(path.join(ui, "hello.marko.go"), "utf8")).toBe(good);
  });

  test("one-shot mode stays fail-fast", async () => {
    const { ui } = fixture({ "bad.marko": BROKEN });
    expect(generateProject(ui)).rejects.toThrow();
  });

  test("a missing directory is still an UnsupportedError in both modes", async () => {
    expect(generateProject("/definitely/not/here")).rejects.toThrow(UnsupportedError);
    expect(
      generateProject("/definitely/not/here", { bestEffort: true }),
    ).rejects.toThrow(UnsupportedError);
  });
});
