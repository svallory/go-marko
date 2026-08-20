import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateProject } from "../src/project.mjs";
import { sanitizeNpmPackageName } from "../src/names.mjs";

/**
 * FR9a: custom tags installed from npm packages.
 *
 * A package provides tags to a project the same way the real Marko compiler
 * discovers them: root `marko.json` `{ "exports": "./dist/tags" }`, `.marko`
 * files under that directory, and the CONSUMING project's package.json
 * listing the package as a dependency. The compiler then emits a BARE
 * import specifier for the tag (`import _x from "pkg/dist/tags/x.marko"`),
 * which marko-go must resolve with node resolution -- from the importing
 * file's own directory, against the PROJECT's node_modules, never
 * codegen's own.
 */

const dirs = [];

/**
 * Build a temp project: `files` become `<root>/ui/**`, `packages` become
 * `<root>/node_modules/<name>/**`, and package.json/go.mod are written so
 * both node resolution and marko-go's own go.mod discovery work.
 */
function fixture({ files, packages = {}, deps = Object.keys(packages) }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-vendor-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "go.mod"), "module myapp\n\ngo 1.24\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])),
    }),
  );

  const ui = path.join(root, "ui");
  for (const [rel, source] of Object.entries(files)) {
    const full = path.join(ui, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }

  for (const [pkgName, pkgFiles] of Object.entries(packages)) {
    const pkgDir = path.join(root, "node_modules", pkgName);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(pkgDir, "marko.json"),
      JSON.stringify({ exports: "./dist/tags" }),
    );
    for (const [rel, source] of Object.entries(pkgFiles)) {
      const full = path.join(pkgDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, source);
    }
  }

  return { root, ui };
}

afterEach(() => {
  let d;
  while ((d = dirs.pop())) fs.rmSync(d, { recursive: true, force: true });
});

function byRel(results, root) {
  return new Map(results.map((r) => [path.relative(root, r.outPath).split(path.sep).join("/"), r.code]));
}

describe("sanitizeNpmPackageName", () => {
  test("unscoped name passes through lowercase, hyphens to underscores", () => {
    expect(sanitizeNpmPackageName("fancy-tags")).toBe("fancy_tags");
  });

  test("scoped name: @scope/name -> scope_name", () => {
    expect(sanitizeNpmPackageName("@acme/ui-kit")).toBe("acme_ui_kit");
  });

  test("leading digits get a pkg prefix, never a bare digit-led identifier", () => {
    expect(sanitizeNpmPackageName("123-tags")).toBe("pkg123_tags");
  });

  test("a name that sanitizes to all separators falls back to 'pkg'", () => {
    expect(sanitizeNpmPackageName("---")).toBe("pkg");
    expect(sanitizeNpmPackageName("@---/---")).toBe("pkg");
  });

  test("never produces a leading underscore or dot (Go tooling skips those dirs)", () => {
    for (const n of ["@scope/name", "_leading", ".dotfile", "123", "@_/_x", "--x"]) {
      const s = sanitizeNpmPackageName(n);
      expect(s[0]).not.toBe("_");
      expect(s[0]).not.toBe(".");
      expect(s.length).toBeGreaterThan(0);
    }
  });

  test("non [a-z0-9_] characters collapse to single underscores", () => {
    expect(sanitizeNpmPackageName("Weird.Name!!Here")).toBe("weird_name_here");
  });
});

describe("unscoped npm tag package", () => {
  test("resolves a bare import, compiles it, and lands it under marko_modules/<pkg>/", async () => {
    const { root, ui } = fixture({
      files: {
        "page.marko": [
          "export interface Input {}",
          "",
          '<fancy-badge label="hi"/>',
          "",
        ].join("\n"),
      },
      packages: {
        "fancy-tags": {
          "dist/tags/fancy-badge.marko": [
            "export interface Input {",
            "  label: string;",
            "}",
            "",
            '<span class="fancy-badge">${input.label}</span>',
            "",
          ].join("\n"),
        },
      },
    });

    const { goFiles: results } = await generateProject(ui);
    const files = byRel(results, root);

    expect([...files.keys()].sort()).toEqual(
      ["marko_modules/fancy_tags/fancy-badge.marko.go", "ui/page.marko.go"].sort(),
    );
    expect(fs.existsSync(path.join(root, "marko_modules/fancy_tags/fancy-badge.marko.go"))).toBe(
      true,
    );

    const badge = files.get("marko_modules/fancy_tags/fancy-badge.marko.go");
    expect(badge).toContain("package fancy_tags");
    expect(badge).toContain("func FancyBadge(w *runtime.Writer, input FancyBadgeInput) {");
    expect(badge).toContain("type FancyBadgeInput struct {");
    expect(badge).toContain("Label string");

    const page = files.get("ui/page.marko.go");
    expect(page).toContain('"myapp/marko_modules/fancy_tags"');
    expect(page).toContain("fancy_tags.FancyBadge(w, fancy_tags.FancyBadgeInput{");
    expect(page).toContain('Label: "hi",');
  });

  test("a package tag importing a sibling tag from its own package resolves recursively", async () => {
    const { root, ui } = fixture({
      files: {
        "page.marko": ['export interface Input {}', "", "<fancy-badge/>", ""].join("\n"),
      },
      packages: {
        "fancy-tags": {
          "dist/tags/fancy-badge.marko": [
            "export interface Input {}",
            "",
            '<span><fancy-icon/></span>',
            "",
          ].join("\n"),
          "dist/tags/fancy-icon.marko": ['<span class="icon">*</span>', ""].join("\n"),
        },
      },
    });

    const { goFiles: results } = await generateProject(ui);
    const files = byRel(results, root);

    expect(files.has("marko_modules/fancy_tags/fancy-icon.marko.go")).toBe(true);
    const badge = files.get("marko_modules/fancy_tags/fancy-badge.marko.go");
    // Same Go package as fancy-icon (both from fancy-tags) -> unqualified call.
    expect(badge).toContain("package fancy_tags");
    expect(badge).toContain("FancyIcon(w, FancyIconInput{})");
    expect(badge).not.toContain("fancy_tags.FancyIcon");
  });

  test("sibling tags under DIFFERENT subdirectories of one package still share a flat Go package -- no self-import", async () => {
    // dist/tags/a/thing.marko and dist/tags/b/thing.marko both flatten into
    // marko_modules/fancy_tags -- qualifying the cross-call by source `dir`
    // (instead of by Go import path) would emit a self-import cycle.
    const { root, ui } = fixture({
      files: {
        "page.marko": [
          'import Thing from "fancy-tags/dist/tags/a/thing.marko"',
          "export interface Input {}",
          "",
          "<Thing/>",
          "",
        ].join("\n"),
      },
      packages: {
        "fancy-tags": {
          "dist/tags/a/thing.marko": [
            'import Thing from "../b/thing.marko"',
            "<div><Thing/></div>",
            "",
          ].join("\n"),
          "dist/tags/b/thing.marko": ["<span>b</span>", ""].join("\n"),
        },
      },
    });

    const { goFiles: results } = await generateProject(ui);
    const files = byRel(results, root);
    const a = files.get("marko_modules/fancy_tags/thing.marko.go");

    expect(a).toContain("package fancy_tags");
    expect(a).not.toContain("import (");
    expect(a).not.toContain("myapp/marko_modules/fancy_tags");
    expect(a).toContain("BThing(w, BThingInput{})");
  });
});

describe("scoped npm tag package", () => {
  test("@scope/name sanitizes to scope_name for both package and import path", async () => {
    const { root, ui } = fixture({
      files: {
        "page.marko": ['export interface Input {}', "", '<ui-chip text="hey"/>', ""].join("\n"),
      },
      packages: {
        "@acme/ui-kit": {
          "dist/tags/ui-chip.marko": [
            "export interface Input {",
            "  text: string;",
            "}",
            "",
            '<span class="chip">${input.text}</span>',
            "",
          ].join("\n"),
        },
      },
    });

    const { goFiles: results } = await generateProject(ui);
    const files = byRel(results, root);

    expect(files.has("marko_modules/acme_ui_kit/ui-chip.marko.go")).toBe(true);
    const chip = files.get("marko_modules/acme_ui_kit/ui-chip.marko.go");
    expect(chip).toContain("package acme_ui_kit");
    expect(chip).toContain("func UiChip(w *runtime.Writer, input UiChipInput) {");

    const page = files.get("ui/page.marko.go");
    expect(page).toContain('"myapp/marko_modules/acme_ui_kit"');
    expect(page).toContain("acme_ui_kit.UiChip(w, acme_ui_kit.UiChipInput{");
  });
});

describe("both a scoped and an unscoped package used together", () => {
  test("each lands in its own marko_modules/<pkg>/ dir with correct func/Input names", async () => {
    const { root, ui } = fixture({
      files: {
        "page.marko": [
          "export interface Input {}",
          "",
          '<fancy-badge label="a"/>',
          '<ui-chip text="b"/>',
          "",
        ].join("\n"),
      },
      packages: {
        "fancy-tags": {
          "dist/tags/fancy-badge.marko": [
            "export interface Input { label: string; }",
            "",
            "<span>${input.label}</span>",
            "",
          ].join("\n"),
        },
        "@acme/ui-kit": {
          "dist/tags/ui-chip.marko": [
            "export interface Input { text: string; }",
            "",
            "<span>${input.text}</span>",
            "",
          ].join("\n"),
        },
      },
    });

    const { goFiles: results } = await generateProject(ui);
    const files = byRel(results, root);

    expect([...files.keys()].sort()).toEqual(
      [
        "marko_modules/fancy_tags/fancy-badge.marko.go",
        "marko_modules/acme_ui_kit/ui-chip.marko.go",
        "ui/page.marko.go",
      ].sort(),
    );
  });
});

describe("collision within one package", () => {
  test("two same-basename templates at different subpaths get disambiguated", async () => {
    const { root, ui } = fixture({
      files: {
        "page.marko": [
          "export interface Input {}",
          "",
          '<one-badge/>',
          '<two-badge/>',
          "",
        ].join("\n"),
      },
      packages: {
        "fancy-tags": {
          "dist/tags/one/badge.marko": ["<span>one</span>", ""].join("\n"),
          "dist/tags/two/badge.marko": ["<span>two</span>", ""].join("\n"),
        },
      },
    });
    // These aren't discoverable as <one-badge>/<two-badge> by the real Marko
    // taglib resolver (it indexes by file name, "badge"), so drive the
    // resolution machinery directly instead of through a page's markup.
    const { addVendorTemplate, findGoModule } = await import("../src/project.mjs");
    const mod = findGoModule(ui);
    const registry = new Map();
    const importer = path.join(root, "ui", "page.marko");
    const one = addVendorTemplate(registry, "fancy-tags/dist/tags/one/badge.marko", importer, mod);
    const two = addVendorTemplate(registry, "fancy-tags/dist/tags/two/badge.marko", importer, mod);

    expect(one.markoPath).not.toBe(two.markoPath);
    expect(one.outPath).not.toBe(two.outPath);
    // The flat basename ("badge") must not be reused verbatim for BOTH --
    // the second one to be added disambiguates using its subpath (the
    // first keeps the plain name; only a real collision pays the cost).
    expect(path.basename(one.outPath)).toBe("badge.marko.go");
    expect(path.basename(two.outPath)).not.toBe("badge.marko.go");
    expect(one.pascalName).not.toBe(two.pascalName);
  });
});

describe("sanitization edge cases end to end", () => {
  test("a package name that sanitizes to a leading digit still yields a valid Go path", async () => {
    const { root, ui } = fixture({
      files: {
        "page.marko": ['export interface Input {}', "", "<weird-tag/>", ""].join("\n"),
      },
      packages: {
        "123-tags": {
          "dist/tags/weird-tag.marko": ["<span>x</span>", ""].join("\n"),
        },
      },
    });

    const { goFiles: results } = await generateProject(ui);
    const files = byRel(results, root);
    const rel = [...files.keys()].find((k) => k.startsWith("marko_modules/"));
    expect(rel).toBe("marko_modules/pkg123_tags/weird-tag.marko.go");
    // No path segment starts with `_` or `.`.
    for (const seg of rel.split("/")) {
      expect(seg[0]).not.toBe("_");
      expect(seg[0]).not.toBe(".");
    }
  });
});

describe("project templates and node_modules stay separate", () => {
  test("a project template that only uses project tags never touches marko_modules", async () => {
    const { root, ui } = fixture({
      files: {
        "page.marko": [
          'import LocalWidget from "./local-widget.marko"',
          "export interface Input {}",
          "",
          "<LocalWidget/>",
          "",
        ].join("\n"),
        "local-widget.marko": ["<div>local</div>", ""].join("\n"),
      },
    });

    const { goFiles: results } = await generateProject(ui);
    expect(fs.existsSync(path.join(root, "marko_modules"))).toBe(false);
    expect(results).toHaveLength(2);
  });
});
