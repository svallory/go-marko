import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanupSharedGoModule,
  renderWithGoPipeline,
  renderWithJsOracle,
} from "./helpers.mjs";

afterAll(() => {
  cleanupSharedGoModule();
});

/**
 * `go run` per case (module resolution + first-time build cache warmup on
 * a fresh temp GOCACHE-adjacent module) comfortably exceeds bun:test's
 * default 5s per-test timeout on a cold cache; 20s keeps the whole ~20-case
 * suite under the ~30s budget architecture-guidance.md item 4 asks for
 * while giving each `go run` real headroom.
 */
const GO_RUN_TIMEOUT_MS = 20_000;

/**
 * JS byte-oracle conformance suite (architecture-guidance.md item 4).
 *
 * Tagged slow/oracle: these spawn `go run` per case (compiling the fixture
 * module's own runtime dependency graph) plus an in-process
 * @marko/compiler pass, so they are meaningfully slower than the golden
 * suite. Kept in a separate file/directory so CI can select them
 * explicitly and so a contributor iterating on codegen isn't forced to pay
 * the `go run` cost on every save. Run explicitly with:
 *
 *   bun test test/oracle
 *
 * See divergences.md for fixtures deliberately EXCLUDED here because Go
 * and JS output legitimately differ today -- those are backlog items, not
 * bugs in this harness.
 */

const CASES = [
  {
    name: "static html",
    marko: "ui/pages/static.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "Static",
    inputs: [{ jsInput: {}, goInput: "pages.StaticInput{}" }],
  },
  {
    name: "escaped interpolation",
    marko: "ui/pages/interpolate.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "Interpolate",
    inputs: [
      { jsInput: { name: "" }, goInput: 'pages.InterpolateInput{Name: ""}' },
      {
        jsInput: { name: `<script>&"'` },
        goInput: `pages.InterpolateInput{Name: "<script>&\\"'"}`,
      },
    ],
  },
  {
    name: "if/else",
    marko: "ui/pages/if-else.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "IfElse",
    inputs: [
      { jsInput: { loggedIn: false }, goInput: "pages.IfElseInput{LoggedIn: false}" },
      { jsInput: { loggedIn: true }, goInput: "pages.IfElseInput{LoggedIn: true}" },
    ],
  },
  {
    name: "for + indexed for over a typed slice",
    marko: "ui/pages/for-loop.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "ForLoop",
    inputs: [
      { jsInput: { items: [] }, goInput: "pages.ForLoopInput{Items: []string{}}" },
      {
        jsInput: { items: ["a", "b", "c"] },
        goInput: 'pages.ForLoopInput{Items: []string{"a", "b", "c"}}',
      },
    ],
  },
  {
    name: "nested Input struct",
    marko: "ui/pages/nested-input.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "NestedInput",
    inputs: [
      {
        jsInput: { user: { name: "", age: 0 } },
        goInput: "pages.NestedInputInput{User: pages.NestedInputInputUser{Name: \"\", Age: 0}}",
      },
      {
        jsInput: { user: { name: "Ada", age: 36 } },
        goInput:
          'pages.NestedInputInput{User: pages.NestedInputInputUser{Name: "Ada", Age: 36}}',
      },
    ],
  },
  {
    name: "attr class array with value-position &&",
    marko: "ui/pages/attr-class-array.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "AttrClassArray",
    inputs: [
      { jsInput: { active: false }, goInput: "pages.AttrClassArrayInput{Active: false}" },
      { jsInput: { active: true }, goInput: "pages.AttrClassArrayInput{Active: true}" },
    ],
  },
  {
    name: "?? fallback",
    marko: "ui/pages/nullish-fallback.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "NullishFallback",
    inputs: [
      // JS: omit the field entirely (true `undefined`, matching an
      // optional TS prop) so `??` actually takes the fallback branch, the
      // same way Go's zero-value "" does.
      { jsInput: {}, goInput: 'pages.NullishFallbackInput{Title: ""}' },
      {
        jsInput: { title: "Custom" },
        goInput: 'pages.NullishFallbackInput{Title: "Custom"}',
      },
    ],
  },
  {
    name: "computed member on module const",
    marko: "ui/pages/module-const.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "ModuleConst",
    inputs: [
      { jsInput: { variant: "default" }, goInput: 'pages.ModuleConstInput{Variant: "default"}' },
      { jsInput: { variant: "outline" }, goInput: 'pages.ModuleConstInput{Variant: "outline"}' },
    ],
  },
  {
    name: "$global read",
    marko: "ui/pages/global-read.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "GlobalRead",
    // $global.path has no fallback in the template, so the empty/zero case
    // and the populated case both come from $global.
    inputs: [
      {
        jsInput: { $global: { path: "" } },
        goInput: "pages.GlobalReadInput{}",
        setGlobals: 'w.SetGlobals(ui.Globals{Path: ""})',
        extraImports: ['"goldenfix/ui"'],
      },
      {
        jsInput: { $global: { path: "/counter" } },
        goInput: "pages.GlobalReadInput{}",
        setGlobals: 'w.SetGlobals(ui.Globals{Path: "/counter"})',
        extraImports: ['"goldenfix/ui"'],
      },
    ],
  },
  {
    name: "html-script",
    marko: "ui/pages/html-script.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "HtmlScript",
    inputs: [{ jsInput: {}, goInput: "pages.HtmlScriptInput{}" }],
  },
  {
    name: "npm tag package (FR9a vendoring)",
    marko: "ui/pages/vendor-tag.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "VendorTag",
    inputs: [{ jsInput: {}, goInput: "pages.VendorTagInput{}" }],
  },
  {
    name: "@head attr tag caller+callee, Marko.Body content",
    marko: "ui/pages/composed.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "Composed",
    inputs: [{ jsInput: {}, goInput: "pages.ComposedInput{}" }],
  },
  {
    name: "attrs spread on custom tag",
    marko: "ui/pages/attrs-spread.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "AttrsSpread",
    inputs: [{ jsInput: {}, goInput: "pages.AttrsSpreadInput{}" }],
    // KNOWN_DIVERGENCE: "attrs spread / map key order" (divergences.md) --
    // Go's `map[string]any` has no defined iteration order, so
    // runtime.Attrs sorts spread keys alphabetically; JS preserves the
    // object literal's source order. Same rendered attributes, different
    // order -- skipped rather than papered over with e.g. a
    // sort-before-compare normalization, which would hide a REAL ordering
    // divergence a resumability-wave accessor map could depend on.
    knownDivergence: "attrs spread / map key order",
  },
  {
    name: "cross-directory custom tag incl. a grouping folder",
    marko: "ui/pages/cross-dir.marko",
    pkg: "pages",
    pkgImportRel: "pages",
    func: "CrossDir",
    inputs: [{ jsInput: {}, goInput: "pages.CrossDirInput{}" }],
  },
];

describe("JS byte-oracle: Go output matches Marko's real JS html renderer", () => {
  for (const c of CASES) {
    for (const [i, variant] of c.inputs.entries()) {
      const label = `${c.name} [input ${i + 1}/${c.inputs.length}]`;
      const testFn = c.knownDivergence ? test.skip : test;
      testFn(
        c.knownDivergence ? `${label} -- KNOWN_DIVERGENCE: ${c.knownDivergence}` : label,
        async () => {
          // Relative, not absolute: the oracle compiles the SAME temp copy
          // the Go pipeline generated from, because registry ids hash the
          // absolute path. See renderWithJsOracle.
          const jsHtml = await renderWithJsOracle(c.marko, variant.jsInput);
          const goHtml = await renderWithGoPipeline({
            pkgName: c.pkg,
            pkgImportRel: c.pkgImportRel,
            funcName: c.func,
            goInputLiteral: variant.goInput,
            extraImports: variant.extraImports ?? [],
            setGlobals: variant.setGlobals,
          });
          expect(goHtml).toBe(jsHtml);
        },
        GO_RUN_TIMEOUT_MS,
      );
    }
  }
});
