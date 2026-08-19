import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { capitalize, pascalCase } from "./names.mjs";
import { UnsupportedError } from "./errors.mjs";

/**
 * The `export interface Input {...}` declaration is compiled AWAY by
 * @marko/compiler -- the html-target JS carries no type information at all
 * (see the `landing.marko` dump: the interface is simply gone). So the Input
 * struct has to come from the .marko SOURCE.
 *
 * A .marko file is "statements, then markup": everything before the first
 * top-level tag is plain TypeScript (that's how `static const`, `import`,
 * and `export interface Input` are written). We slice that leading section
 * off textually and hand it to Babel with the TS plugin. We deliberately do
 * NOT try to parse the markup -- that's the compiler's job.
 */

/**
 * Find the byte offset where markup begins: the first line whose first
 * non-space character is `<`. Marko requires top-level markup to start a
 * line, so this is reliable for the statement/markup split. Comments and
 * TS/JS statements never begin a line with `<` in valid Marko source
 * (a `<` in that position is always a tag).
 */
export function sliceStatementSection(source) {
  const lines = source.split("\n");
  const out = [];
  for (const line of lines) {
    if (/^\s*</.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Maps a TS type annotation to a Go type per the FR1 contract.
 * Unrecognized shapes degrade to `any` rather than throwing: an Input field
 * we can't type still round-trips through runtime.Escape/Truthy, so `any`
 * is safe. (Unsupported *markup* still fails fast -- that's where wrong Go
 * would actually be silently wrong.)
 *
 * @param node TS type annotation node
 * @param {{owner: string, field: string, nested: Map<string,object[]>}} [ctx]
 *   When present, an inline object type (`{ label: string }`) is emitted as a
 *   NAMED Go struct instead of `map[string]any` -- see nestedStructName for
 *   the naming rule. `ctx.nested` collects `structName -> fields[]` for every
 *   struct generated this way, including deeper levels (recursion re-roots
 *   `owner` at the struct just named). Without ctx the old `map[string]any`
 *   mapping applies, which is what a bare `goTypeForTS(type)` call gets.
 */
export function goTypeForTS(node, ctx) {
  if (!node) return "any";
  switch (node.type) {
    case "TSStringKeyword":
      return "string";
    case "TSBooleanKeyword":
      return "bool";
    // JS has one numeric type. runtime.toJSString prints integral float64s
    // without a decimal point, matching JS `String(1)` === "1".
    case "TSNumberKeyword":
      return "float64";
    case "TSAnyKeyword":
    case "TSUnknownKeyword":
      return "any";
    case "TSArrayType": {
      // The element carries the SAME ctx: `events: {…}[]` names its element
      // struct after the field (`CounterInputEvents`), with no attempt at
      // depluralization -- mechanical and predictable beats clever.
      const elem = goTypeForTS(node.elementType, ctx);
      if (["string", "bool", "float64"].includes(elem)) return `[]${elem}`;
      // A named nested struct is a real Go type, so a slice of it is too.
      if (ctx && isNamedStruct(elem, ctx)) return `[]${elem}`;
      return "[]any";
    }
    case "TSUnionType": {
      // Union of string literals (`"default" | "outline"`) is just a string
      // at runtime. A union mixing kinds has no single Go type -> any.
      const members = node.types.filter(
        (m) => !(m.type === "TSUndefinedKeyword" || m.type === "TSNullKeyword"),
      );
      if (members.length === 0) return "any";
      const mapped = new Set(
        members.map((m) =>
          m.type === "TSLiteralType" ? goTypeForLiteral(m.literal) : goTypeForTS(m, ctx),
        ),
      );
      return mapped.size === 1 ? [...mapped][0] : "any";
    }
    case "TSLiteralType":
      return goTypeForLiteral(node.literal);
    case "TSTypeReference": {
      const name = typeRefName(node.typeName);
      // Marko's ambient namespace. `Marko.Body` is a renderable body --
      // marko-go models it as a plain closure over the Writer.
      if (name === "Marko.Body") return "runtime.Body";
      if (name === "Marko.HTMLAttributes" || name === "Marko.AttrTag") return "map[string]any";
      if (name === "Array" && node.typeParameters?.params?.length === 1) {
        return goTypeForTS(
          { type: "TSArrayType", elementType: node.typeParameters.params[0] },
          ctx,
        );
      }
      return "any";
    }
    case "TSTypeLiteral":
      // Without a naming context there is nothing to call the struct, so it
      // stays an untyped map (the pre-FR3 behavior, still what a direct
      // goTypeForTS(type) call gets).
      return ctx ? declareNestedStruct(node, ctx) : "map[string]any";
    default:
      return "any";
  }
}

/**
 * Naming convention for a struct generated from an inline object type:
 * OUTER STRUCT NAME + PascalCase FIELD NAME, with no depluralization.
 *
 *   CounterInput.events: { label: string }[]  ->  CounterInputEvents
 *   CounterInput.user:   { name: string }     ->  CounterInputUser
 *   FooInput.bar.baz:    { … }                ->  FooInputBarBaz
 *
 * Deliberately mechanical: a reader can derive the name from the template
 * without consulting the generated file, and "events" -> "Event" style
 * depluralization would be a guess that breaks on the first irregular noun.
 */
export function nestedStructName(owner, jsField) {
  return owner + goFieldName(jsField);
}

function isNamedStruct(goType, ctx) {
  return ctx.nested.has(goType);
}

/**
 * Registers a struct declaration for an inline object type and returns its
 * name. Recurses with `owner` re-rooted at the struct just named, so a third
 * level lands on FooInputBarBaz rather than colliding back at FooInputBaz.
 */
function declareNestedStruct(node, ctx) {
  const structName = nestedStructName(ctx.owner, ctx.field);
  // Reserve the name before recursing: a deeper level asks isNamedStruct
  // about types declared at this level, and self-reference would otherwise
  // recurse forever.
  ctx.nested.set(structName, []);
  const fields = [];
  for (const member of node.members ?? []) {
    if (!t.isTSPropertySignature(member)) {
      // An inline object with a method/index signature has no faithful Go
      // struct. Degrade the whole struct to a map rather than emit a type
      // that silently drops members.
      ctx.nested.delete(structName);
      return "map[string]any";
    }
    const jsName = memberKeyName(member);
    if (jsName === null) {
      ctx.nested.delete(structName);
      return "map[string]any";
    }
    fields.push({
      jsName,
      name: goFieldName(jsName),
      goType: goTypeForTS(member.typeAnnotation?.typeAnnotation, {
        owner: structName,
        field: jsName,
        nested: ctx.nested,
      }),
      optional: !!member.optional,
    });
  }
  ctx.nested.set(structName, fields);
  return structName;
}

function memberKeyName(member) {
  if (t.isIdentifier(member.key)) return member.key.name;
  if (t.isStringLiteral(member.key)) return member.key.value;
  return null;
}

function goTypeForLiteral(lit) {
  if (t.isStringLiteral(lit)) return "string";
  if (t.isNumericLiteral(lit)) return "float64";
  if (t.isBooleanLiteral(lit)) return "bool";
  return "any";
}

function typeRefName(node) {
  if (t.isIdentifier(node)) return node.name;
  if (t.isTSQualifiedName(node)) return `${typeRefName(node.left)}.${node.right.name}`;
  return "";
}

/**
 * Extracts `export interface Input { ... }` from .marko source.
 *
 * Inline object types produce ADDITIONAL named structs (see
 * nestedStructName); they're collected on the returned array as a
 * non-enumerable-ish `nested` property rather than a second return value, so
 * every existing `parseInputInterface(...)` call site (and every test that
 * compares the result with toEqual) keeps working unchanged.
 *
 * @param {string} source raw .marko file contents
 * @param {string} markoPath for error messages
 * @param {string} [owner] name of the Go struct these fields belong to,
 *        e.g. "CounterInput" -- the root for nested struct names. Omitting it
 *        disables nested struct generation (inline objects stay
 *        `map[string]any`).
 * @returns {{name: string, goType: string, jsName: string}[] &
 *          {nested: {name: string, fields: object[]}[]}} fields in
 *          declaration order. Empty array when there is no interface or it
 *          declares no members (the struct is still emitted, empty).
 */
export function parseInputInterface(source, markoPath = "<marko>", owner) {
  const head = sliceStatementSection(source);
  if (!/interface\s+Input\b/.test(head)) return withNested([], new Map());

  let ast;
  try {
    ast = parse(head, {
      sourceType: "module",
      plugins: ["typescript"],
      errorRecovery: true,
    });
  } catch (err) {
    throw new UnsupportedError(
      `could not parse the TypeScript statement section of ${markoPath}: ${err.message}`,
    );
  }

  let decl = null;
  for (const node of ast.program.body) {
    const candidate = t.isExportNamedDeclaration(node) ? node.declaration : node;
    if (t.isTSInterfaceDeclaration(candidate) && candidate.id.name === "Input") {
      decl = candidate;
    }
  }
  const nested = new Map();
  if (!decl) return withNested([], nested);

  const fields = [];
  for (const member of decl.body.body) {
    if (!t.isTSPropertySignature(member)) {
      throw new UnsupportedError(
        `only plain properties are supported in \`interface Input\` (${markoPath}), got ${member.type}`,
        member,
      );
    }
    const jsName = t.isIdentifier(member.key)
      ? member.key.name
      : t.isStringLiteral(member.key)
        ? member.key.value
        : null;
    if (jsName === null) {
      throw new UnsupportedError(
        `computed keys are not supported in \`interface Input\` (${markoPath})`,
        member,
      );
    }
    // `?` carries no Go representation: the zero value means "absent".
    // runtime.Or is the `??` analogue -- see its doc comment for the
    // documented divergence from JS nullish semantics.
    fields.push({
      jsName,
      name: goFieldName(jsName),
      goType: goTypeForTS(
        member.typeAnnotation?.typeAnnotation,
        owner ? { owner, field: jsName, nested } : undefined,
      ),
      optional: !!member.optional,
    });
  }
  return withNested(fields, nested);
}

/**
 * Attaches the collected nested struct declarations to the fields array.
 * Non-enumerable so `toEqual`/`JSON.stringify` on the result still see a
 * plain array of fields -- the nested structs are a side channel for the
 * one caller (transpile.mjs) that emits them.
 */
function withNested(fields, nested) {
  Object.defineProperty(fields, "nested", {
    value: [...nested].map(([name, f]) => ({ name, fields: f })),
    enumerable: false,
  });
  return fields;
}

/** `class` -> `Class`, `data-foo` -> `DataFoo`, `type` -> `Type`. */
export function goFieldName(jsName) {
  if (/[-.]/.test(jsName)) return pascalCase(jsName);
  return capitalize(jsName);
}

/**
 * Renders the Go struct declaration. Always emitted, even with no fields,
 * so callers can always write `pkg.FooInput{}`.
 */
export function renderInputStruct(structName, fields) {
  if (fields.length === 0) {
    return `type ${structName} struct{}`;
  }
  const width = Math.max(...fields.map((f) => f.name.length));
  const lines = fields.map((f) => `\t${f.name.padEnd(width)} ${f.goType}`);
  return `type ${structName} struct {\n${lines.join("\n")}\n}`;
}
