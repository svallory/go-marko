import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { plugin } from "bun";
import compiler from "@marko/compiler";
import { generateProject } from "../../src/project.mjs";

/**
 * JS byte-oracle harness (architecture-guidance.md item 4 / "Contract
 * problem").
 *
 * Renders one fixture template TWO ways -- through Marko's own JS `html`
 * renderer (the ground truth: real @marko/compiler + real
 * @marko/runtime-tags, in-process, no marko-go involved) and through
 * marko-go's generated Go, built and run with `go run` -- and byte-compares
 * the two. This is the only check that continuously catches drift between
 * the codegen<->runtime CONTRACT (HANDLED set, emitted call strings,
 * runtime Go signatures) and what the compiler actually emits; goldens
 * alone only catch Go-side drift.
 *
 * Methodology follows notes/fr12-resume-findings.md §7's last paragraph:
 * compile -> run the JS oracle -> byte-diff Go against it. Both bugs the
 * FR12 spike found were caught by this loop in seconds.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, "..", "golden", "fixtures");
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

const TRANSLATOR = createRequire(import.meta.url).resolve(
  "@marko/runtime-tags/translator",
);

/**
 * A `.marko` file imports OTHER `.marko` files directly (custom tags,
 * `@head`/attr-tag callees, ...) -- Marko projects normally resolve those
 * through a bundler's loader, which Bun's plugin API can stand in for
 * directly: `onLoad` intercepts every `.marko` import (this file's entry
 * point AND every transitive one) and compiles it in-process with the same
 * real @marko/compiler + @marko/runtime-tags translator used everywhere
 * else in this repo. Registered once, module-scope, since Bun plugins are
 * process-global.
 */
plugin({
  name: "marko-go-oracle-loader",
  setup(build) {
    build.onLoad({ filter: /\.marko$/ }, async (args) => {
      const src = fs.readFileSync(args.path, "utf8");
      const result = await compiler.compile(src, args.path, {
        translator: TRANSLATOR,
        output: "html",
        optimize: true,
      });
      return { contents: result.code, loader: "js" };
    });
  },
});

/**
 * Render a fixture template through the real JS pipeline (compile -> import
 * -> .render(input)) and return the resulting HTML string.
 *
 * `input` is the plain JS object passed to `.render()` -- for a template
 * that reads `$global`, put those fields under `input.$global` (that's how
 * @marko/runtime-tags itself threads request-scoped globals through
 * `render(input)`; see the compiled `_$global()` call in the transpiled
 * output).
 *
 * ## Why this renders the TEMP COPY, not `fixtures/`
 *
 * Registry ids -- the `_script`/`_content` content hashes that appear
 * verbatim in the resume payload -- hash the template's ABSOLUTE FILE PATH,
 * not just its bytes (wire contract sec 15.1: identical bytes at three
 * different paths produced three different ids). The Go side generates from
 * the temp module `buildSharedGoModule` creates, so the JS oracle must
 * compile the SAME files at the SAME paths or every payload comparison fails
 * on ids alone -- while the markup around them matches perfectly, which is
 * exactly the kind of false failure that erodes trust in a byte oracle.
 *
 * `relMarko` is therefore a path relative to the fixtures root, resolved
 * against the shared temp module. Callers never name an absolute path, so
 * the two halves cannot drift apart.
 */
export async function renderWithJsOracle(relMarko, input = {}) {
  const tmpRoot = await getSharedGoModule();
  // Loaded through the process-global `marko-go-oracle-loader` plugin
  // above (not compiled here directly) so the entry's own `.marko` imports
  // resolve through the same loader, transitively.
  const mod = await import(path.join(tmpRoot, relMarko));
  return String(mod.default.render(input));
}

/**
 * Set up ONE temp Go module for the whole suite: a copy of fixtures/ +
 * freshly generated .marko.go, wired to this repo's runtime package via a
 * `replace` directive. Shared across every case (module-scope memoized)
 * rather than rebuilt per case -- `generateProject` and the file copy are
 * pure overhead repeated identically per fixture, and a shared module dir
 * also lets Go's build cache warm up across cases instead of paying a cold
 * `go run` every time. Call `cleanupSharedGoModule()` once after the suite
 * finishes (e.g. an `afterAll`) to remove it.
 */
let sharedModulePromise;

async function getSharedGoModule() {
  if (!sharedModulePromise) sharedModulePromise = buildSharedGoModule();
  return sharedModulePromise;
}

async function buildSharedGoModule() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-oracle-"));
  const uiSrc = path.join(FIXTURES, "ui");
  const uiDst = path.join(tmpRoot, "ui");
  fs.cpSync(uiSrc, uiDst, { recursive: true });
  // node_modules (the tiny-tags vendor package) lives at the fixture ROOT,
  // not under ui/ -- copy it too so vendor resolution still works from the
  // temp copy.
  const nmSrc = path.join(FIXTURES, "node_modules");
  const nmDst = path.join(tmpRoot, "node_modules");
  if (fs.existsSync(nmSrc)) {
    fs.cpSync(nmSrc, nmDst, { recursive: true });
  }
  // The JS oracle now renders the TEMP copy (see renderWithJsOracle), so the
  // templates' own `import ... from "@marko/runtime-tags/html"` has to resolve
  // from here too. The fixture's node_modules carries only the vendor tag
  // package, so link this repo's runtime in beside it -- a symlink, so both
  // halves load the SAME module instance at the pinned version rather than a
  // second copy with its own module state.
  fs.mkdirSync(path.join(nmDst, "@marko"), { recursive: true });
  const runtimeLink = path.join(nmDst, "@marko", "runtime-tags");
  if (!fs.existsSync(runtimeLink)) {
    fs.symlinkSync(
      path.dirname(
        createRequire(import.meta.url).resolve("@marko/runtime-tags/package.json"),
      ),
      runtimeLink,
      "dir",
    );
  }
  // package.json is what node resolution -- both the real @marko/compiler
  // resolving a vendor tag's package, and this file's own createRequire
  // walks -- anchors package boundaries on; without a copy here the
  // vendor-tag fixture fails to compile from the temp root.
  const pkgJsonSrc = path.join(FIXTURES, "package.json");
  if (fs.existsSync(pkgJsonSrc)) {
    fs.cpSync(pkgJsonSrc, path.join(tmpRoot, "package.json"));
  }

  fs.writeFileSync(
    path.join(tmpRoot, "go.mod"),
    [
      "module goldenfix",
      "",
      "go 1.22",
      "",
      "require github.com/svallory/go-marko v0.0.0",
      "",
      `replace github.com/svallory/go-marko => ${REPO_ROOT}`,
      "",
    ].join("\n"),
  );

  const { diagnostics } = await generateProject(uiDst, { bestEffort: true });
  if (diagnostics.length) {
    throw new Error(
      `generateProject failed for oracle harness: ${diagnostics
        .map((d) => `${d.markoPath}: ${d.error.message}`)
        .join("; ")}`,
    );
  }

  return tmpRoot;
}

/** Remove the shared temp Go module. Safe to call even if never built. */
export function cleanupSharedGoModule() {
  if (!sharedModulePromise) return;
  const p = sharedModulePromise;
  sharedModulePromise = undefined;
  return p.then((tmpRoot) => fs.rmSync(tmpRoot, { recursive: true, force: true }));
}

/**
 * Run a tiny generated `main.go` against the shared fixture module (see
 * `getSharedGoModule`) that calls `pkg.Func(w, input)` and prints
 * `w.String()`.
 *
 * `pkgImportRel` is the Go import path suffix under the fixture module for
 * the package the function lives in (e.g. "pages" or
 * "tags/widgets"), matching how project.mjs derives goImportPath from the
 * template's directory relative to the module root's `ui/` tree --
 * concretely: `path.relative(uiDir, dir)` joined with "/", rooted under
 * "goldenfix/ui".
 *
 * `goInputLiteral` is a Go composite literal source fragment for the
 * template's Input struct (e.g. `pages.StaticInput{}` or
 * `pages.ForLoopInput{Items: []string{"a", "b"}}`) -- the test itself picks
 * these because only the test knows what values are interesting to probe
 * per fixture (empty/zero case + a populated case).
 *
 * `setGlobals`, if given, is a Go source fragment run before the render
 * call, e.g. `w.SetGlobals(ui.Globals{Path: "/counter"})` -- callers that
 * need it also supply the `ui` import via `extraImports`.
 *
 * Each case gets its own `main.go` under a distinct `cmd/<id>/` directory
 * inside the shared module (rather than a shared `main.go` file) so
 * concurrent cases never race on the same file, and `go run ./cmd/<id>`
 * still resolves every generated package through the ONE shared module
 * root.
 */
export async function renderWithGoPipeline({
  pkgName,
  pkgImportRel,
  funcName,
  goInputLiteral,
  extraImports = [],
  setGlobals,
}) {
  const tmpRoot = await getSharedGoModule();
  const id = `${funcName}_${Math.random().toString(36).slice(2, 8)}`;
  const cmdDir = path.join(tmpRoot, ".oracle-cmd", id);
  fs.mkdirSync(cmdDir, { recursive: true });

  const imports = [
    '"fmt"',
    '"github.com/svallory/go-marko/runtime"',
    `"goldenfix/ui/${pkgImportRel}"`,
    ...extraImports,
  ];
  const main = [
    "package main",
    "",
    "import (",
    ...imports.map((i) => `\t${i}`),
    ")",
    "",
    "func main() {",
    "\tw := runtime.New()",
    ...(setGlobals ? [`\t${setGlobals}`] : []),
    `\t${pkgName}.${funcName}(w, ${goInputLiteral})`,
    "\tfmt.Print(w.String())",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(cmdDir, "main.go"), main);

  try {
    const proc = Bun.spawnSync({
      cmd: ["go", "run", "-buildvcs=false", `./.oracle-cmd/${id}`],
      cwd: tmpRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `go run failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}`,
      );
    }
    return proc.stdout.toString();
  } finally {
    fs.rmSync(cmdDir, { recursive: true, force: true });
  }
}
