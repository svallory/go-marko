import { describe, expect, test } from "bun:test";
import {
  goTypeForTS,
  parseInputInterface,
  renderInputStruct,
  sliceStatementSection,
  goFieldName,
} from "../src/inputstruct.mjs";
import { parse } from "@babel/parser";

/** Parse a bare TS type annotation so goTypeForTS can be tested directly. */
function tsType(src) {
  const ast = parse(`type X = ${src};`, { sourceType: "module", plugins: ["typescript"] });
  return ast.program.body[0].typeAnnotation;
}

const map = (src) => goTypeForTS(tsType(src));

describe("goTypeForTS", () => {
  test("primitives", () => {
    expect(map("string")).toBe("string");
    expect(map("boolean")).toBe("bool");
    // JS has a single numeric type; runtime.toJSString prints integral
    // float64 without a decimal point.
    expect(map("number")).toBe("float64");
    expect(map("any")).toBe("any");
    expect(map("unknown")).toBe("any");
  });

  test("string-literal unions collapse to string", () => {
    expect(map(`"default" | "secondary" | "outline"`)).toBe("string");
    expect(map(`"a" | "b" | undefined`)).toBe("string");
    expect(map("1 | 2")).toBe("float64");
    expect(map("true | false")).toBe("bool");
  });

  test("mixed unions degrade to any", () => {
    expect(map(`"a" | 3`)).toBe("any");
    expect(map("string | number")).toBe("any");
  });

  test("arrays", () => {
    expect(map("string[]")).toBe("[]string");
    expect(map("number[]")).toBe("[]float64");
    expect(map("boolean[]")).toBe("[]bool");
    expect(map("Array<string>")).toBe("[]string");
    // Element type has no Go equivalent -> []any, never a wrong element type.
    expect(map("Foo[]")).toBe("[]any");
    expect(map("{a: string}[]")).toBe("[]any");
    expect(map("string[][]")).toBe("[]any");
  });

  test("Marko ambient types", () => {
    expect(map("Marko.Body")).toBe("runtime.Body");
    expect(map("Marko.HTMLAttributes")).toBe("map[string]any");
  });

  test("object literal types become maps", () => {
    expect(map("{ a: string; b: number }")).toBe("map[string]any");
  });

  test("unrecognized references degrade to any, never throw", () => {
    expect(map("SomeUnknownType")).toBe("any");
    expect(map("() => void")).toBe("any");
    expect(goTypeForTS(undefined)).toBe("any");
  });
});

describe("goFieldName", () => {
  test("capitalizes, keeping Go reserved-ish words exported", () => {
    expect(goFieldName("class")).toBe("Class");
    expect(goFieldName("type")).toBe("Type");
    expect(goFieldName("variant")).toBe("Variant");
    expect(goFieldName("dataFoo")).toBe("DataFoo");
  });
  test("kebab attribute names become PascalCase", () => {
    expect(goFieldName("data-theme-switcher")).toBe("DataThemeSwitcher");
  });
});

describe("sliceStatementSection", () => {
  test("stops at the first line beginning with a tag", () => {
    const src = [
      "// comment",
      "export interface Input { a?: string }",
      "static const x = 1;",
      "",
      "<div>",
      "  export interface NotInput {}",
      "</div>",
    ].join("\n");
    const head = sliceStatementSection(src);
    expect(head).toContain("interface Input");
    expect(head).not.toContain("NotInput");
  });
});

describe("parseInputInterface", () => {
  test("real ui-button interface", () => {
    const src = `// leading comment
export interface Input {
  variant?: "default" | "secondary" | "outline" | "ghost";
  size?: "default" | "icon";
  href?: string;
  type?: "button" | "submit" | "reset";
  class?: string;
  attrs?: Marko.HTMLAttributes;
  content?: Marko.Body;
}

static const base = "x";

<div/>
`;
    expect(parseInputInterface(src)).toEqual([
      { jsName: "variant", name: "Variant", goType: "string", optional: true },
      { jsName: "size", name: "Size", goType: "string", optional: true },
      { jsName: "href", name: "Href", goType: "string", optional: true },
      { jsName: "type", name: "Type", goType: "string", optional: true },
      { jsName: "class", name: "Class", goType: "string", optional: true },
      { jsName: "attrs", name: "Attrs", goType: "map[string]any", optional: true },
      { jsName: "content", name: "Content", goType: "runtime.Body", optional: true },
    ]);
  });

  test("required vs optional produce the same Go type (zero value == absent)", () => {
    const fields = parseInputInterface(
      `export interface Input { title?: string; content: Marko.Body }\n<div/>`,
    );
    expect(fields.map((f) => [f.name, f.goType, f.optional])).toEqual([
      ["Title", "string", true],
      ["Content", "runtime.Body", false],
    ]);
  });

  test("empty interface and no interface both yield no fields", () => {
    expect(parseInputInterface("export interface Input {}\n<div/>")).toEqual([]);
    expect(parseInputInterface("<div/>")).toEqual([]);
  });

  test("quoted keys are supported", () => {
    expect(parseInputInterface(`export interface Input { "data-x"?: string }\n<div/>`)).toEqual([
      { jsName: "data-x", name: "DataX", goType: "string", optional: true },
    ]);
  });

  test("a non-exported interface Input is still picked up", () => {
    expect(parseInputInterface("interface Input { a?: boolean }\n<div/>")).toEqual([
      { jsName: "a", name: "A", goType: "bool", optional: true },
    ]);
  });

  test("method signatures fail fast rather than silently vanishing", () => {
    expect(() =>
      parseInputInterface("export interface Input { doThing(): void }\n<div/>"),
    ).toThrow(/only plain properties/);
  });
});

describe("renderInputStruct", () => {
  test("empty struct", () => {
    expect(renderInputStruct("LandingInput", [])).toBe("type LandingInput struct{}");
  });

  test("field names are column-aligned like gofmt", () => {
    const go = renderInputStruct("XInput", [
      { name: "Title", goType: "string" },
      { name: "Content", goType: "runtime.Body" },
    ]);
    expect(go).toBe(
      "type XInput struct {\n\tTitle   string\n\tContent runtime.Body\n}",
    );
  });
});
