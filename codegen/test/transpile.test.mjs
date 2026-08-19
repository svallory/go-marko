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
