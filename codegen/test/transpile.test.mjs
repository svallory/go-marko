import { describe, expect, test } from "bun:test";
import { transpile, UnsupportedError, alignKeyValueRuns } from "../src/transpile.mjs";

/**
 * Builds a minimal html-target module of the shape @marko/compiler emits, so
 * expression/statement translation can be exercised without running the real
 * compiler on a fixture file for every case.
 */
function mod(body, { imports = [], head = "", tagImports = "" } = {}) {
  const names = new Set(["_html", "_template", ...imports]);
  return `${tagImports}
import { ${[...names].join(", ")} } from "@marko/runtime-tags/html";
${head}
export default _template("id", input => {
${body}
}, 1);
`;
}

function go(body, opts = {}) {
  const { code } = transpile(mod(body, opts), {
    goPackage: "views",
    templateName: "widget",
    pascalName: "Widget",
    inputFields: opts.inputFields ?? [],
    resolveTag: opts.resolveTag,
    ...opts.transpileOpts,
  });
  return code;
}

/** Body of the generated render func, trimmed, for compact assertions. */
function renderBody(code) {
  const m = /func Widget\(w \*runtime\.Writer, input WidgetInput\) \{\n([\s\S]*?)\n\}\n$/.exec(code);
  if (!m) throw new Error("could not find render func in:\n" + code);
  return m[1].split("\n").map((l) => l.replace(/^\t/, "")).join("\n");
}

describe("expressions", () => {
  test("?? becomes runtime.Or", () => {
    const code = go(`_html(\`<p>\${_escape(input.title ?? "fallback")}</p>\`);`, {
      imports: ["_escape"],
    });
    expect(code).toContain(`runtime.Escape(runtime.Or(input.Title, "fallback"))`);
  });

  test("chained ?? nests Or left-associatively, as in JS", () => {
    const code = go(`_html(\`\${_escape(input.a ?? input.b ?? "z")}\`);`, {
      imports: ["_escape"],
    });
    expect(code).toContain(`runtime.Or(runtime.Or(input.A, input.B), "z")`);
  });

  test("computed member access maps to a Go index", () => {
    const code = go(`_html(\`\${_escape(table[input.key])}\`);`, {
      imports: ["_escape"],
      head: `const table = {a: "1"};`,
    });
    // Module-level consts are prefixed with the camelCase template name so
    // sibling templates in the same Go package can't collide.
    expect(code).toContain("widgetTable[input.Key]");
  });

  test("member access is capitalized; .length becomes len()", () => {
    const code = go(`_html(\`\${_escape(input.items.length)}\`);`, { imports: ["_escape"] });
    expect(code).toContain("len(input.Items)");
  });

  test("string concat chains pass straight through", () => {
    const code = go(`_html("x");`, { head: `const s = "a" + "b" + "c";` });
    expect(code).toContain(`var widgetS = "a" + "b" + "c"`);
  });

  test("all-string object literal becomes map[string]string", () => {
    const code = go(`_html("x");`, { head: `const v = {a: "1", b: "2"};` });
    expect(code).toContain("var widgetV = map[string]string{");
    expect(code).toContain(`"a": "1",`);
  });

  test("mixed-value object literal becomes map[string]any", () => {
    const code = go(`_html("x");`, { head: `const v = {a: "1", b: 2};` });
    expect(code).toContain("var widgetV = map[string]any{");
  });

  test("array literal becomes []any (element type is unknowable from JS)", () => {
    const code = go(`const classes = [input.class, "x"];\n_html("y");`);
    expect(renderBody(code)).toContain(`classes := []any{input.Class, "x"}`);
  });

  test("=== / !== normalize to Go comparisons", () => {
    const code = go(`if (input.a === "x") { _html("y"); }`);
    expect(code).toContain(`runtime.Truthy(input.A == "x")`);
  });

  test("the ternary operator fails fast with a location", () => {
    expect(() => go(`_html(\`\${_escape(input.a ? 1 : 2)}\`);`, { imports: ["_escape"] })).toThrow(
      UnsupportedError,
    );
    expect(() => go(`_html(\`\${_escape(input.a ? 1 : 2)}\`);`, { imports: ["_escape"] })).toThrow(
      /ternary.*at \d+:\d+/s,
    );
  });
});

describe("intrinsics", () => {
  test("_attr_class / _attr_style route to the runtime porters", () => {
    const code = go(`_html(\`<i\${_attr_class(input.class)}\${_attr_style(input.style)}></i>\`);`, {
      imports: ["_attr_class", "_attr_style"],
    });
    expect(code).toContain("w.HTML(runtime.AttrClass(input.Class))");
    expect(code).toContain("w.HTML(runtime.AttrStyle(input.Style))");
  });

  test("_attr becomes runtime.Attr(name, value)", () => {
    const code = go(`_html(\`<i\${_attr("id", input.id)}></i>\`);`, { imports: ["_attr"] });
    expect(code).toContain(`w.HTML(runtime.Attr("id", input.Id))`);
  });

  test("_attrs preserves property order and turns spread into a map item", () => {
    const code = go(
      `_html(\`<a\${_attrs({href: input.href, class: classes, ...input.attrs}, "a", 0, "a")}>\`);`,
      { imports: ["_attrs"], head: "const classes = 1;" },
    );
    expect(code).toContain(
      `w.HTML(runtime.Attrs(runtime.A{Name: "href", Value: input.Href}, ` +
        `runtime.A{Name: "class", Value: widgetClasses}, input.Attrs))`,
    );
  });

  test("_attr_nonce is dropped (no $global CSP nonce in marko-go)", () => {
    const code = go(`_html(\`<script\${_attr_nonce()} src=x></script>\`);`, {
      imports: ["_attr_nonce"],
    });
    expect(code).not.toContain("nonce");
    expect(code).toContain(`w.HTML("<script")`);
    expect(code).toContain(`w.HTML(" src=x></script>")`);
  });

  test("resume-only intrinsics are dropped entirely", () => {
    const code = go(
      `const $r = _scope_reason();\nconst $s = _scope_id();\n_html("hi");\n_script($s, "x");\n(_serialize_if($r, 0)) && _scope($s, {});`,
      { imports: ["_scope_reason", "_scope_id", "_script", "_serialize_if", "_scope"] },
    );
    expect(renderBody(code)).toBe(`w.HTML("hi")`);
  });

  test("_dynamic_tag over an input body becomes a nil-guarded call", () => {
    const code = go(`_dynamic_tag(0, "b", input.content, {}, 0, 0, 0);`, {
      imports: ["_dynamic_tag"],
      inputFields: [{ name: "Content", goType: "runtime.Body" }],
    });
    expect(renderBody(code)).toBe("if input.Content != nil {\n\tinput.Content(w)\n}");
  });

  test("a dynamic tag over anything else fails fast", () => {
    expect(() =>
      go(`_dynamic_tag(0, "b", SomeComponent, {}, 0, 0, 0);`, { imports: ["_dynamic_tag"] }),
    ).toThrow(/dynamic tags are only supported for a body passed as input/);
  });

  test("rendering a body-typed field declared as string is rejected", () => {
    expect(() =>
      go(`_dynamic_tag(0, "b", input.content, {}, 0, 0, 0);`, {
        imports: ["_dynamic_tag"],
        inputFields: [{ name: "Content", goType: "string" }],
      }),
    ).toThrow(/declare it as Marko\.Body/);
  });

  test("an intrinsic outside the subset is refused at the import, not silently emitted", () => {
    expect(() =>
      transpile(mod(`_html("x");`, { imports: ["_await"] }), {
        goPackage: "views",
        templateName: "widget",
        pascalName: "Widget",
      }),
    ).toThrow(/"_await" is not part of the ported subset/);
  });
});

describe("cross-module tag calls", () => {
  const registry = {
    "./icon-book.marko": {
      pkgName: "icons",
      pascalName: "IconBook",
      goImportPath: "myapp/ui/icons",
      inputFields: new Map([["Class", "string"]]),
      sameDir: true,
      alias: "icons",
    },
    "../elements/ui-button.marko": {
      pkgName: "elements",
      pascalName: "UiButton",
      goImportPath: "myapp/ui/elements",
      inputFields: new Map([
        ["Attrs", "map[string]any"],
        ["Content", "runtime.Body"],
      ]),
      sameDir: false,
      alias: "elements",
    },
  };
  const resolveTag = (spec) => registry[spec] ?? null;

  test("same-directory tags are called unqualified and add no import", () => {
    const code = go(`_iconBook({class: "size-4"});`, {
      tagImports: `import _iconBook from "./icon-book.marko";`,
      resolveTag,
    });
    expect(renderBody(code)).toBe(
      'IconBook(w, IconBookInput{\n\tClass: "size-4",\n})',
    );
    expect(code).toBe(code.replace(/myapp\/ui\/icons/, "myapp/ui/icons")); // sanity
    expect(code).not.toContain(`"myapp/ui/icons"`);
  });

  test("cross-directory tags are package-qualified and imported", () => {
    const code = go(`_uiButton({variant: "ghost"});`, {
      tagImports: `import _uiButton from "../elements/ui-button.marko";`,
      resolveTag,
    });
    expect(code).toContain(`\t"myapp/ui/elements"\n`);
    expect(renderBody(code)).toBe(
      'elements.UiButton(w, elements.UiButtonInput{\n\tVariant: "ghost",\n})',
    );
  });

  test("a tag with no attributes gets an empty struct literal", () => {
    const code = go(`_uiButton({});`, {
      tagImports: `import _uiButton from "../elements/ui-button.marko";`,
      resolveTag,
    });
    expect(renderBody(code)).toBe("elements.UiButton(w, elements.UiButtonInput{})");
  });

  test("a content: _content(...) argument becomes a runtime.Body closure", () => {
    const code = go(
      `_uiButton({content: _content("x", () => { _html("hi"); }, 0)});`,
      {
        imports: ["_content"],
        tagImports: `import _uiButton from "../elements/ui-button.marko";`,
        resolveTag,
      },
    );
    expect(renderBody(code)).toBe(
      "elements.UiButton(w, elements.UiButtonInput{\n" +
        "\tContent: func(w *runtime.Writer) {\n" +
        '\t\tw.HTML("hi")\n' +
        "\t},\n" +
        "})",
    );
  });

  test("_content_resume translates identically to _content", () => {
    const code = go(
      `_uiButton({content: _content_resume("x", () => { _html("hi"); }, 0)});`,
      {
        imports: ["_content_resume"],
        tagImports: `import _uiButton from "../elements/ui-button.marko";`,
        resolveTag,
      },
    );
    expect(renderBody(code)).toContain("Content: func(w *runtime.Writer) {");
  });

  test("attrs={...} is typed map[string]any because the callee declares it", () => {
    const code = go(`_uiButton({attrs: {"data-x": "true"}});`, {
      tagImports: `import _uiButton from "../elements/ui-button.marko";`,
      resolveTag,
    });
    // All values are strings, so translateObjectAsMap would pick
    // map[string]string -- the callee's declared field type wins.
    expect(renderBody(code)).toContain('Attrs: map[string]any{\n\t\t"data-x": "true",\n\t},');
  });

  test("an unresolvable .marko import fails fast", () => {
    expect(() =>
      go(`_ghost({});`, {
        tagImports: `import _ghost from "./nowhere.marko";`,
        resolveTag,
      }),
    ).toThrow(/could not be resolved to a template in the project/);
  });
});

describe("module shape", () => {
  test("package clause, func name and struct name derive from the file name", () => {
    const { code } = transpile(mod(`_html("x");`), {
      goPackage: "elements",
      templateName: "ui-button",
      pascalName: "UiButton",
      inputFields: [{ name: "Class", goType: "string" }],
    });
    expect(code).toStartWith("// Code generated by marko-go. DO NOT EDIT.\npackage elements\n");
    expect(code).toContain("type UiButtonInput struct {\n\tClass string\n}");
    expect(code).toContain("func UiButton(w *runtime.Writer, input UiButtonInput) {");
  });

  test("a single import is emitted without a parenthesized block", () => {
    expect(go(`_html("x");`)).toContain('import "github.com/svallory/go-marko/runtime"');
  });

  test("non-html-target input is rejected", () => {
    expect(() =>
      transpile(`export default 1;`, {
        goPackage: "x",
        templateName: "a",
        pascalName: "A",
      }),
    ).toThrow(/is this html-target output/);
  });
});

describe("alignKeyValueRuns (gofmt composite-literal alignment)", () => {
  test("aligns a run and stops at a non-entry line", () => {
    expect(
      alignKeyValueRuns(["\tA: 1,", "\tBcd: 2,", "\tsomethingElse()", "\tE: 3,"].join("\n")),
    ).toBe(["\tA:   1,", "\tBcd: 2,", "\tsomethingElse()", "\tE: 3,"].join("\n"));
  });

  test("a multi-line value breaks the run, as gofmt does", () => {
    expect(
      alignKeyValueRuns(["\tA: 1,", "\tBcd: map[string]any{", '\t\t"x": 1,', "\t},"].join("\n")),
    ).toBe(["\tA: 1,", "\tBcd: map[string]any{", '\t\t"x": 1,', "\t},"].join("\n"));
  });

  test("different indent levels are aligned independently", () => {
    expect(alignKeyValueRuns(["\tA: 1,", "\t\tBcd: 2,"].join("\n"))).toBe(
      ["\tA: 1,", "\t\tBcd: 2,"].join("\n"),
    );
  });

  test("a URL inside a string literal is never mistaken for a key/value entry", () => {
    const src = ['\tw.HTML("http://x")', "\tHref: 1,"].join("\n");
    expect(alignKeyValueRuns(src)).toBe(src);
  });
});

describe("closure bookkeeping is dropped", () => {
  test("`const x__closures = new Set()` produces no Go", () => {
    // The compiler emits one of these per reactive signal so `_subscribe`
    // can register client-side closures. Server-only rendering never reads
    // them, so they must vanish rather than become a Go statement.
    const code = go(
      [
        `const $input_events__closures = new Set();`,
        `const $input_global__closures = new Set();`,
        `_html("<p>hi</p>");`,
      ].join("\n"),
    );
    expect(renderBody(code)).toBe(`w.HTML("<p>hi</p>")`);
    expect(code).not.toContain("closures");
    expect(code).not.toContain("Set");
  });

  test("_subscribe nested inside a && guard is dropped whole", () => {
    // Real shape from counter.marko: the guard is a LogicalExpression whose
    // right side is a _subscribe call wrapping further _subscribe/_scope
    // calls. Only the OUTERMOST callee is inspected, which is enough.
    const code = go(
      [
        `const $input_events__closures = new Set();`,
        `_html("<p>hi</p>");`,
        `($si__x) && _subscribe($input_events__closures, _subscribe($input_events__closures, _scope($scope1_id, {})));`,
      ].join("\n"),
      { imports: ["_subscribe", "_scope"] },
    );
    expect(renderBody(code)).toBe(`w.HTML("<p>hi</p>")`);
  });

  test("_resume_branch is dropped", () => {
    const code = go(`_html("<p>hi</p>");\n_resume_branch($scope1_id);`, {
      imports: ["_resume_branch"],
    });
    expect(renderBody(code)).toBe(`w.HTML("<p>hi</p>")`);
  });
});

describe("typed for-of", () => {
  const eventsInput = {
    inputFields: [{ name: "Events", goType: "[]WidgetInputEvents", jsName: "events" }],
    transpileOpts: {
      nestedStructs: [
        {
          name: "WidgetInputEvents",
          fields: [
            { name: "Label", goType: "string", jsName: "label" },
            { name: "Count", goType: "float64", jsName: "count" },
          ],
        },
      ],
    },
  };

  test("a statically typed slice yields the generic ForOf and a typed param", () => {
    const code = go(
      `_for_of(input.events, (event) => { _html(\`<li>\${_escape(event.label)}</li>\`); }, 0, 0, "a", 0, 0, 0, "</ul>", 1);`,
      { imports: ["_for_of", "_escape"], ...eventsInput },
    );
    expect(code).toContain(
      "runtime.ForOf(input.Events, func(event WidgetInputEvents) {",
    );
    // The loop var's type is in scope, so field access resolves to a real
    // Go struct field rather than needing an assertion.
    expect(code).toContain("runtime.Escape(event.Label)");
    expect(code).toContain(`w.HTML("</ul>")`);
  });

  test("a second callback param becomes ForOfIndexed with an int index", () => {
    const code = go(
      `_for_of(input.events, (event, i) => { _html(\`<li>\${_escape(i)}\${_escape(event.count)}</li>\`); }, 0, 0, "a", 0, 0, 0, "", 1);`,
      { imports: ["_for_of", "_escape"], ...eventsInput },
    );
    expect(code).toContain(
      "runtime.ForOfIndexed(input.Events, func(event WidgetInputEvents, i int) {",
    );
    expect(code).toContain("runtime.Escape(event.Count)");
  });

  test("a []string field also gets the generic form", () => {
    const code = go(
      `_for_of(input.items, (item) => { _html(\`<li>\${_escape(item)}</li>\`); }, 0, 0, "a", 0, 0, 0, "", 1);`,
      {
        imports: ["_for_of", "_escape"],
        inputFields: [{ name: "Items", goType: "[]string", jsName: "items" }],
      },
    );
    expect(code).toContain("runtime.ForOf(input.Items, func(item string) {");
  });

  test("an unknown element type falls back to the reflective *Any helpers", () => {
    const anyField = {
      inputFields: [{ name: "Things", goType: "[]any", jsName: "things" }],
    };
    const one = go(
      `_for_of(input.things, (thing) => { _html("<li>"); }, 0, 0, "a", 0, 0, 0, "", 1);`,
      { imports: ["_for_of"], ...anyField },
    );
    expect(one).toContain("runtime.ForOfAny(input.Things, func(thing any) {");
    const two = go(
      `_for_of(input.things, (thing, i) => { _html("<li>"); }, 0, 0, "a", 0, 0, 0, "", 1);`,
      { imports: ["_for_of"], ...anyField },
    );
    expect(two).toContain("runtime.ForOfIndexedAny(input.Things, func(thing any, i int) {");
  });

  test("an untyped source (no Input field at all) also falls back", () => {
    const code = go(
      `_for_of(input.mystery, (x) => { _html("<li>"); }, 0, 0, "a", 0, 0, 0, "", 1);`,
      { imports: ["_for_of"] },
    );
    expect(code).toContain("runtime.ForOfAny(input.Mystery, func(x any) {");
  });

  test("nested loops infer through the outer loop variable's struct", () => {
    const code = go(
      `_for_of(input.groups, (group) => {
         _for_of(group.rows, (row) => { _html(\`<li>\${_escape(row.name)}</li>\`); }, 0, 0, "b", 0, 0, 0, "", 1);
       }, 0, 0, "a", 0, 0, 0, "", 1);`,
      {
        imports: ["_for_of", "_escape"],
        inputFields: [{ name: "Groups", goType: "[]WidgetInputGroups", jsName: "groups" }],
        transpileOpts: {
          nestedStructs: [
            {
              name: "WidgetInputGroups",
              fields: [{ name: "Rows", goType: "[]WidgetInputGroupsRows", jsName: "rows" }],
            },
            {
              name: "WidgetInputGroupsRows",
              fields: [{ name: "Name", goType: "string", jsName: "name" }],
            },
          ],
        },
      },
    );
    expect(code).toContain("runtime.ForOf(input.Groups, func(group WidgetInputGroups) {");
    expect(code).toContain(
      "runtime.ForOf(group.Rows, func(row WidgetInputGroupsRows) {",
    );
    expect(code).toContain("runtime.Escape(row.Name)");
  });

  test("a loop variable's type does not leak past its loop", () => {
    // `item` in the second loop must NOT pick up the first loop's type.
    const code = go(
      `_for_of(input.items, (item) => { _html("<a>"); }, 0, 0, "a", 0, 0, 0, "", 1);
       _for_of(input.things, (item) => { _html("<b>"); }, 0, 0, "b", 0, 0, 0, "", 1);`,
      {
        imports: ["_for_of"],
        inputFields: [
          { name: "Items", goType: "[]string", jsName: "items" },
          { name: "Things", goType: "[]any", jsName: "things" },
        ],
      },
    );
    expect(code).toContain("runtime.ForOf(input.Items, func(item string) {");
    expect(code).toContain("runtime.ForOfAny(input.Things, func(item any) {");
  });

  test("three callback params are still rejected", () => {
    expect(() =>
      go(`_for_of(input.items, (a, b, c) => { _html("x"); }, 0, 0, "a", 0, 0, 0, "", 1);`, {
        imports: ["_for_of"],
      }),
    ).toThrow(UnsupportedError);
  });

  test("nested Input structs are emitted after the Input struct", () => {
    const code = go(`_html("<p>x</p>");`, eventsInput);
    expect(code).toContain(
      "type WidgetInput struct {\n\tEvents []WidgetInputEvents\n}",
    );
    expect(code).toContain(
      "type WidgetInputEvents struct {\n\tLabel string\n\tCount float64\n}",
    );
    expect(code.indexOf("type WidgetInput struct")).toBeLessThan(
      code.indexOf("type WidgetInputEvents struct"),
    );
  });
});

describe("value-position logical operators", () => {
  test("`i === 0 && \"cls\"` in a class array becomes runtime.And", () => {
    // JS && returns an OPERAND, not a bool: the array entry is either false
    // (skipped by AttrClass) or the class string.
    const code = go(
      `_html(\`<li\${_attr_class(["base", i === 0 && "bg-accent/50 font-medium"])}>\`);`,
      { imports: ["_attr_class"] },
    );
    expect(code).toContain(
      `runtime.AttrClass([]any{"base", runtime.And(i == 0, "bg-accent/50 font-medium")})`,
    );
  });

  test("`||` with a non-boolean operand becomes runtime.OrValue", () => {
    const code = go(`_html(\`<p>\${_escape(input.title || "untitled")}</p>\`);`, {
      imports: ["_escape"],
      inputFields: [{ name: "Title", goType: "string", jsName: "title" }],
    });
    expect(code).toContain(`runtime.OrValue(input.Title, "untitled")`);
  });

  test("both operands boolean-shaped keeps the native Go operator", () => {
    const code = go(`_if(() => { if (input.a === 1 && !input.b) { _html("<p>y</p>"); } });`, {
      imports: ["_if"],
    });
    expect(code).toContain("if runtime.Truthy(input.A == 1 && !input.B) {");
    expect(code).not.toContain("runtime.And");
  });

  test("a bool-typed Input field counts as boolean-shaped", () => {
    const code = go(`_if(() => { if (input.open || input.pinned) { _html("<p>y</p>"); } });`, {
      imports: ["_if"],
      inputFields: [
        { name: "Open", goType: "bool", jsName: "open" },
        { name: "Pinned", goType: "bool", jsName: "pinned" },
      ],
    });
    expect(code).toContain("input.Open || input.Pinned");
    expect(code).not.toContain("runtime.OrValue");
  });

  test("?? still maps to runtime.Or, not OrValue", () => {
    const code = go(`_html(\`<p>\${_escape(input.title ?? "fallback")}</p>\`);`, {
      imports: ["_escape"],
    });
    expect(code).toContain(`runtime.Or(input.Title, "fallback")`);
    expect(code).not.toContain("runtime.OrValue");
  });

  test("a mixed chain nests And/OrValue left-associatively", () => {
    const code = go(`_html(\`<p>\${_escape(input.a && input.b || "z")}</p>\`);`, {
      imports: ["_escape"],
    });
    expect(code).toContain(`runtime.OrValue(runtime.And(input.A, input.B), "z")`);
  });
});

/**
 * FR10 -- `$global`, the request-scoped context.
 *
 * Compiled JS imports it as `$global as _$global`, binds it once with
 * `const $global = _$global()`, and then does plain member reads. The Go
 * side pulls it off the Writer with a comma-ok assertion so a render with
 * no globals yields the zero value instead of panicking.
 */
describe("$global (FR10)", () => {
  const globalsEntry = {
    pkgName: "ui",
    goImportPath: "myapp/ui",
    fieldTypes: new Map([["Path", "string"], ["Count", "float64"]]),
    sameDir: false,
    alias: "ui",
  };
  const resolveGlobals = () => globalsEntry;

  test("the $global binding becomes a comma-ok assertion off the Writer", () => {
    const code = go(`const $global = _$global();\n_html("<p>hi</p>");`, {
      imports: ["$global as _$global"],
      transpileOpts: { resolveGlobals },
    });
    expect(renderBody(code)).toContain("markoGlobal, _ := w.Globals().(ui.Globals)");
  });

  test("the globals package is imported, aliased like any cross-package dep", () => {
    const code = go(`const $global = _$global();\n_html("<p>hi</p>");`, {
      imports: ["$global as _$global"],
      transpileOpts: { resolveGlobals },
    });
    expect(code).toContain(`\t"myapp/ui"\n`);
  });

  test("a same-package Globals is unqualified and adds no import", () => {
    const code = go(`const $global = _$global();\n_html("<p>hi</p>");`, {
      imports: ["$global as _$global"],
      transpileOpts: {
        resolveGlobals: () => ({ ...globalsEntry, sameDir: true }),
      },
    });
    expect(renderBody(code)).toContain("markoGlobal, _ := w.Globals().(Globals)");
    expect(code).not.toContain(`"myapp/ui"`);
  });

  test("member reads are capitalized and typed from the Globals fields", () => {
    // A `string`-typed global compared with === stays a native Go
    // comparison, which only type-checks because Path is known to be string.
    const code = go(
      `const $global = _$global();\n_html(\`\${_escape($global.path === "/x")}\`);`,
      { imports: ["$global as _$global", "_escape"], transpileOpts: { resolveGlobals } },
    );
    expect(code).toContain(`markoGlobal.Path == "/x"`);
  });

  test("a template that never reads $global needs no globals declaration", () => {
    const code = go(`_html("<p>hi</p>");`, {
      transpileOpts: { resolveGlobals: () => null },
    });
    expect(code).toContain("w.HTML(\"<p>hi</p>\")");
    expect(code).not.toContain("w.Globals()");
  });

  test("using $global with no global.d.ts names the file to create", () => {
    expect(() =>
      go(`const $global = _$global();\n_html("<p>hi</p>");`, {
        imports: ["$global as _$global"],
        transpileOpts: { resolveGlobals: () => null },
      }),
    ).toThrow(/global\.d\.ts/);
  });
});

/**
 * FR11 -- attr tags (`<@head>`), Marko's named sections.
 *
 * Caller emits `head: _attrTag({content: _content_resume(...)})`; callee
 * declares `head?: Marko.AttrTag<{content: Marko.Body}>`, which maps to a
 * POINTER field so `<if=input.head>` can test for absence.
 */
describe("attr tags (FR11)", () => {
  const resolveTag = (spec) =>
    spec === "../layouts/page-layout.marko"
      ? {
          pkgName: "layouts",
          pascalName: "PageLayout",
          goImportPath: "myapp/ui/layouts",
          inputFields: new Map([
            ["Head", "*PageLayoutInputHead"],
            ["Content", "runtime.Body"],
          ]),
          sameDir: false,
          alias: "layouts",
        }
      : null;

  const CALL = `_pageLayout({head: _attrTag({content: _content_resume("x", () => { _html("<meta name=description>"); }, 0)})});`;
  const opts = {
    imports: ["_content_resume", "attrTag as _attrTag"],
    tagImports: `import _pageLayout from "../layouts/page-layout.marko";`,
    resolveTag,
  };

  test("the caller emits &<Callee>Input<Field>{Content: closure}", () => {
    const body = renderBody(go(CALL, opts));
    expect(body).toContain("Head: &layouts.PageLayoutInputHead{");
    expect(body).toContain("Content: func(w *runtime.Writer) {");
    expect(body).toContain(`w.HTML("<meta name=description>")`);
  });

  test("the struct name comes from the CALLEE's declared type, not a guess", () => {
    // Renaming the callee's field type must move the caller with it.
    const code = go(CALL, {
      ...opts,
      resolveTag: () => ({
        pkgName: "layouts",
        pascalName: "PageLayout",
        goImportPath: "myapp/ui/layouts",
        inputFields: new Map([["Head", "*SomethingElse"]]),
        sameDir: false,
        alias: "layouts",
      }),
    });
    expect(code).toContain("&layouts.SomethingElse{");
  });

  test("passing <@head> to a template that declares no such section fails loudly", () => {
    expect(() =>
      go(CALL, {
        ...opts,
        resolveTag: () => ({
          pkgName: "layouts",
          pascalName: "PageLayout",
          goImportPath: "myapp/ui/layouts",
          inputFields: new Map(),
          sameDir: false,
          alias: "layouts",
        }),
      }),
    ).toThrow(/Marko\.AttrTag/);
  });

  test("an attr-tag attribute other than content is rejected", () => {
    expect(() =>
      go(
        `_pageLayout({head: _attrTag({title: "x", content: _content_resume("x", () => {}, 0)})});`,
        opts,
      ),
    ).toThrow(UnsupportedError);
  });

  test("the callee tests a pointer section with != nil, not runtime.Truthy", () => {
    const code = go(
      `_if(() => { if (input.head) { _dynamic_tag(0, "a", input.head.content, {}, 0, 0, 0); return 0; } }, 0, "c");`,
      {
        imports: ["_if", "_dynamic_tag"],
        transpileOpts: {
          inputFields: [{ name: "Head", goType: "*WidgetInputHead", jsName: "head" }],
          nestedStructs: [
            { name: "WidgetInputHead", fields: [{ name: "Content", goType: "runtime.Body" }] },
          ],
        },
      },
    );
    const body = renderBody(code);
    expect(body).toContain("if input.Head != nil {");
    expect(body).not.toContain("runtime.Truthy(input.Head)");
    // The section body renders through the same nil-guarded Body call as
    // the template's own content.
    expect(body).toContain("if input.Head.Content != nil {");
    expect(body).toContain("input.Head.Content(w)");
  });

  test("optional chaining on a section reads as a plain member access", () => {
    // `input.head?.content` shows up in resume-only bookkeeping the
    // transpiler drops, but the expression translator must still handle it.
    const code = go(
      `_if(() => { if (input.head) { _dynamic_tag(0, "a", input.head?.content, {}, 0, 0, 0); return 0; } }, 0, "c");`,
      {
        imports: ["_if", "_dynamic_tag"],
        transpileOpts: {
          inputFields: [{ name: "Head", goType: "*WidgetInputHead", jsName: "head" }],
          nestedStructs: [
            { name: "WidgetInputHead", fields: [{ name: "Content", goType: "runtime.Body" }] },
          ],
        },
      },
    );
    expect(renderBody(code)).toContain("input.Head.Content(w)");
  });
});
