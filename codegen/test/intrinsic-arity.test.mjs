import { describe, expect, test } from "bun:test";
import { parse } from "@babel/parser";
import compiler from "@marko/compiler";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Guards the toolchain pin (see README.md "Toolchain pinning"). This file
 * does NOT import anything from codegen/src -- on purpose. transpile.mjs
 * asserts exact intrinsic names, import shapes and call arities against the
 * JS that `@marko/compiler` + `@marko/runtime-tags` actually emit; those
 * assumptions live only in transpile.mjs's own code, which this test must
 * stay independent of so it keeps testing the *real* compiler output rather
 * than transpile.mjs's own (possibly also-wrong) expectations.
 *
 * Approach: compile small in-memory probe templates with the real, pinned
 * compiler, then parse the resulting JS with @babel/parser and assert on
 * its AST directly -- import specifier names, and the arity/shape of each
 * HANDLED intrinsic's call sites. If a Marko version bump changes any of
 * these, this test fails first and names exactly which intrinsic changed.
 *
 * Intrinsics NOT covered here (RESUME_ONLY -- transpile.mjs drops them
 * outright, so a shape change there cannot silently corrupt generated Go;
 * worst case is a new UnsupportedError, which is safe by construction):
 * _scope_reason, _serialize_guard, _serialize_if, _set_serialize_reason,
 * _scope_id, _scope, _scope_with_id, _el_resume, _sep, _script, _subscribe,
 * _resume_branch, _resume, _resume_locals, _peek_scope_id, _existing_scope,
 * _id.
 */

const require_ = createRequire(import.meta.url);
const TRANSLATOR = require_.resolve("@marko/runtime-tags/translator");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marko-go-arity-"));

/**
 * Compiles a probe .marko source (optionally alongside sibling files, e.g.
 * a callee component) with the real pinned @marko/compiler and returns the
 * html-target JS.
 *
 * @param {string} name file name, e.g. "probe.marko"
 * @param {string} src marko source
 * @param {Record<string,string>} [siblings] extra files written to the same
 *        dir first, e.g. a component the probe template imports
 */
async function compileProbe(name, src, siblings = {}) {
  for (const [siblingName, siblingSrc] of Object.entries(siblings)) {
    fs.writeFileSync(path.join(dir, siblingName), siblingSrc);
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, src);
  const result = await compiler.compile(src, file, {
    translator: TRANSLATOR,
    output: "html",
    optimize: true,
  });
  return result.code;
}

/** Parses compiled JS and returns its Program AST. */
function ast(code) {
  return parse(code, { sourceType: "module" }).program;
}

/** Local (post-import-rename) names bound by the module's import declarations. */
function importedLocalNames(program) {
  const names = new Set();
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") continue;
    for (const spec of node.specifiers) {
      if (spec.type === "ImportSpecifier" || spec.type === "ImportDefaultSpecifier") {
        names.add(spec.local.name);
      }
    }
  }
  return names;
}

/** Maps each imported local name to the imported (source) name it was renamed from. */
function importedNameMap(program) {
  const map = new Map();
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") continue;
    for (const spec of node.specifiers) {
      if (spec.type === "ImportSpecifier") {
        const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
        map.set(spec.local.name, imported);
      }
    }
  }
  return map;
}

/**
 * Finds every CallExpression in `program` whose callee is the local name
 * `localName`, walking the whole AST (not just the top level) since
 * intrinsics are called from inside arrow functions / _template's callback.
 */
function findCalls(program, localName) {
  const found = [];
  function walk(node) {
    if (!node || typeof node.type !== "string") return;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === localName
    ) {
      found.push(node);
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const v of value) walk(v);
      } else if (value && typeof value.type === "string") {
        walk(value);
      }
    }
  }
  for (const n of program.body) walk(n);
  return found;
}

function fail(intrinsic, detail) {
  throw new Error(
    `${detail} (intrinsic: ${intrinsic}) -- Marko toolchain contract changed -- see codegen/README.md Toolchain pinning`,
  );
}

describe("intrinsic contract: _html / _escape", () => {
  test("imported under their own names; _html(templateLiteral), _escape(expr)", async () => {
    const code = await compileProbe(
      "html-escape.marko",
      "export interface Input { title: string }\n<p>${input.title}</p>\n",
    );
    const program = ast(code);
    const locals = importedLocalNames(program);
    if (!locals.has("_html")) fail("_html", "expected `_html` to be imported by name");
    if (!locals.has("_escape")) fail("_escape", "expected `_escape` to be imported by name");

    const htmlCalls = findCalls(program, "_html");
    if (htmlCalls.length === 0) fail("_html", "expected at least one _html(...) call");
    if (htmlCalls[0].arguments.length !== 1) {
      fail("_html", `expected _html(arg) to be called with exactly 1 argument, got ${htmlCalls[0].arguments.length}`);
    }
    if (htmlCalls[0].arguments[0].type !== "TemplateLiteral") {
      fail("_html", `expected _html's argument to be a template literal, got ${htmlCalls[0].arguments[0].type}`);
    }

    const escapeCalls = findCalls(program, "_escape");
    if (escapeCalls.length !== 1) fail("_escape", `expected exactly one _escape(...) call, got ${escapeCalls.length}`);
    if (escapeCalls[0].arguments.length !== 1) {
      fail("_escape", `expected _escape(expr) to take exactly 1 argument, got ${escapeCalls[0].arguments.length}`);
    }
  });
});

describe("intrinsic contract: _for_of", () => {
  test("indexed loop: callback(item, index) and parentEndTag trailing string arg", async () => {
    const code = await compileProbe(
      "for-of.marko",
      [
        "export interface Input { items: string[] }",
        "<ul>",
        "  <for|item, i| of=input.items>",
        "    <li>${item}${i}</li>",
        "  </for>",
        "</ul>",
      ].join("\n"),
    );
    const program = ast(code);
    if (!importedLocalNames(program).has("_for_of")) {
      fail("_for_of", "expected `_for_of` to be imported by name");
    }

    const calls = findCalls(program, "_for_of");
    if (calls.length !== 1) fail("_for_of", `expected exactly one _for_of(...) call, got ${calls.length}`);
    const [call] = calls;

    const [items, cb, ...rest] = call.arguments;
    if (items.type !== "MemberExpression") {
      fail("_for_of", `expected 1st arg (items) to be a member expression, got ${items.type}`);
    }
    if (cb.type !== "ArrowFunctionExpression") {
      fail("_for_of", `expected 2nd arg (callback) to be an arrow function, got ${cb.type}`);
    }
    if (cb.params.length !== 2) {
      fail("_for_of", `expected the loop callback to take (item, index) -- 2 params, got ${cb.params.length}`);
    }
    // transpile.mjs relies on a fixed positional tail after the callback:
    // by, scopeId, accessor, ...serializeGuards, parentEndTag, forFlags.
    // The exact count has shifted across intrinsics before (see _dynamic_tag);
    // pin it here so any change is visible immediately rather than as a
    // silent wrong-argument read inside transpile.mjs.
    if (rest.length < 6) {
      fail(
        "_for_of",
        `expected at least 6 positional args after (items, callback) -- by, scopeId, accessor, serialize guards, parentEndTag, forFlags -- got ${rest.length}`,
      );
    }
    const last = rest[rest.length - 1];
    const secondToLast = rest[rest.length - 2];
    if (last.type !== "NumericLiteral") {
      fail("_for_of", `expected the final positional arg (forFlags) to be a numeric literal, got ${last.type}`);
    }
    if (secondToLast.type !== "StringLiteral") {
      fail(
        "_for_of",
        `expected the second-to-last positional arg (parentEndTag, e.g. "</ul>") to be a string literal, got ${secondToLast.type}`,
      );
    }
    if (secondToLast.value !== "</ul>") {
      fail("_for_of", `expected parentEndTag to be the literal "</ul>", got ${JSON.stringify(secondToLast.value)}`);
    }
  });
});

describe("intrinsic contract: _if / else", () => {
  test("callback returning branch-index ints; trailing branch-index literals", async () => {
    const code = await compileProbe(
      "if-else.marko",
      [
        "export interface Input { flag: boolean }",
        "<if=input.flag>",
        "  <p>yes</p>",
        "</if>",
        "<else>",
        "  <p>no</p>",
        "</else>",
      ].join("\n"),
    );
    const program = ast(code);
    if (!importedLocalNames(program).has("_if")) fail("_if", "expected `_if` to be imported by name");

    const calls = findCalls(program, "_if");
    if (calls.length !== 1) fail("_if", `expected exactly one _if(...) call, got ${calls.length}`);
    const [call] = calls;

    const cb = call.arguments[0];
    if (cb.type !== "ArrowFunctionExpression") {
      fail("_if", `expected 1st arg (branch callback) to be an arrow function, got ${cb.type}`);
    }
    const body = cb.body.type === "BlockStatement" ? cb.body.body : [cb.body];
    const ifStmt = body.find((n) => n.type === "IfStatement");
    if (!ifStmt) fail("_if", "expected the branch callback body to contain a native `if` statement");
    if (!ifStmt.alternate) fail("_if", "expected the native `if` statement to have an `else` branch");

    function returnValue(stmt) {
      const stmts = stmt.type === "BlockStatement" ? stmt.body : [stmt];
      const ret = stmts.find((n) => n.type === "ReturnStatement");
      if (!ret) fail("_if", "expected each `if`/`else` branch to end with a `return <branch-index>`");
      if (ret.argument.type !== "NumericLiteral") {
        fail("_if", `expected the branch return value to be a numeric literal, got ${ret.argument.type}`);
      }
      return ret.argument.value;
    }
    if (returnValue(ifStmt.consequent) !== 0) fail("_if", "expected the `if` branch to return 0");
    if (returnValue(ifStmt.alternate) !== 1) fail("_if", "expected the `else` branch to return 1");

    // Trailing positional args include the two branch-index literals
    // (0, 1) the branch callback's returns correspond to.
    const trailingNumerics = call.arguments.slice(1).filter((a) => a.type === "NumericLiteral");
    const trailingValues = trailingNumerics.map((n) => n.value);
    if (!trailingValues.includes(0) || !trailingValues.includes(1)) {
      fail(
        "_if",
        `expected trailing numeric args to include the branch indices 0 and 1, got [${trailingValues.join(", ")}]`,
      );
    }
  });
});

describe("intrinsic contract: _content / _content_resume", () => {
  test("_content(id, rendererFn, parentScopeId): 3 args, renderer is a block-bodied function", async () => {
    const code = await compileProbe(
      "content.marko",
      [
        'import Card from "./card.marko"',
        "export interface Input { title: string }",
        "<Card>",
        "  <p>${input.title}</p>",
        "</Card>",
      ].join("\n"),
      { "card.marko": "export interface Input { content?: any }\n<div><${input.content}/></div>\n" },
    );
    const program = ast(code);
    const nameMap = importedNameMap(program);
    // The compiler is free to route this specific probe through `_content`
    // or `_content_resume` (both exist in HANDLED and translate identically
    // per transpile.mjs) -- assert on whichever one it actually emitted.
    const contentLocal = [...nameMap.entries()].find(
      ([, imported]) => imported === "_content" || imported === "_content_resume",
    );
    if (!contentLocal) fail("_content/_content_resume", "expected a _content or _content_resume import");
    const [localName, importedName] = contentLocal;

    const calls = findCalls(program, localName);
    if (calls.length !== 1) fail(importedName, `expected exactly one ${importedName}(...) call, got ${calls.length}`);
    const [call] = calls;
    if (call.arguments.length !== 3) {
      fail(importedName, `expected ${importedName}(id, renderer, parentScopeId) -- 3 args, got ${call.arguments.length}`);
    }
    if (call.arguments[0].type !== "StringLiteral") {
      fail(importedName, `expected 1st arg (registry id) to be a string literal, got ${call.arguments[0].type}`);
    }
    if (call.arguments[1].type !== "ArrowFunctionExpression" || call.arguments[1].body.type !== "BlockStatement") {
      fail(importedName, "expected 2nd arg (renderer) to be a block-bodied arrow function");
    }
  });

  test("_content_resume has the identical (id, rendererFn, parentScopeId) shape as _content", () => {
    // The compiler did not choose to emit _content_resume for the probes
    // exercised above (both templates hit the `_content` path). Per
    // transpile.mjs's own doc comment, `_content` and `_content_resume`
    // "differ only in whether the closure is registered for client-side
    // resume; both wrap the same renderer function" -- i.e. this is a
    // deliberately identical-arity sibling of the case just proven against
    // the real compiler above, not a separate contract to reverse-engineer.
    // Guard the shape directly against a hand-built module of the kind
    // @marko/compiler emits, so a rename/arity change to *either* name is
    // still caught even on inputs where the compiler prefers the other one.
    const code = [
      'import { _html, _content_resume, _template } from "@marko/runtime-tags/html";',
      'export default _template("id", input => {',
      '  _uiCard({ content: _content_resume("x", () => { _html("hi"); }, 0) });',
      "}, 1);",
    ].join("\n");
    const program = ast(code);
    const calls = findCalls(program, "_content_resume");
    if (calls.length !== 1) fail("_content_resume", `expected exactly one call, got ${calls.length}`);
    if (calls[0].arguments.length !== 3) {
      fail("_content_resume", `expected 3 args, got ${calls[0].arguments.length}`);
    }
  });
});

describe("intrinsic contract: _dynamic_tag", () => {
  test("(scopeId, accessor, tagNameExpr, attrsObj, contentExpr, ...guards)", async () => {
    const code = await compileProbe(
      "dynamic-tag.marko",
      "export interface Input { tag: string }\n<${input.tag}>hi</>\n",
    );
    const program = ast(code);
    if (!importedLocalNames(program).has("_dynamic_tag")) {
      fail("_dynamic_tag", "expected `_dynamic_tag` to be imported by name");
    }
    const calls = findCalls(program, "_dynamic_tag");
    if (calls.length !== 1) fail("_dynamic_tag", `expected exactly one call, got ${calls.length}`);
    const [call] = calls;
    if (call.arguments.length < 5) {
      fail(
        "_dynamic_tag",
        `expected at least 5 args (scopeId, accessor, tagName, attrs, content, ...) got ${call.arguments.length}`,
      );
    }
    const [scopeId, accessor, tagName, attrs, content] = call.arguments;
    if (accessor.type !== "StringLiteral") {
      fail("_dynamic_tag", `expected 2nd arg (accessor) to be a string literal, got ${accessor.type}`);
    }
    if (tagName.type !== "MemberExpression") {
      fail("_dynamic_tag", `expected 3rd arg (tag name expr) to be a member expression, got ${tagName.type}`);
    }
    if (attrs.type !== "ObjectExpression") {
      fail("_dynamic_tag", `expected 4th arg (attrs) to be an object expression, got ${attrs.type}`);
    }
    if (content.type !== "CallExpression") {
      fail(
        "_dynamic_tag",
        `expected 5th arg (content) to be a _content/_content_resume(...) call, got ${content.type}`,
      );
    }
  });
});

describe("intrinsic contract: _attrs", () => {
  test("(attrsObjectWithSpread, accessor, scopeId, tagName): 4 args, object literal with a spread element", async () => {
    const code = await compileProbe(
      "attrs.marko",
      "export interface Input { href: string, attrs: object }\n<a href=input.href ...input.attrs>x</a>\n",
    );
    const program = ast(code);
    if (!importedLocalNames(program).has("_attrs")) {
      fail("_attrs", "expected `_attrs` to be imported by name");
    }
    const calls = findCalls(program, "_attrs");
    if (calls.length !== 1) fail("_attrs", `expected exactly one _attrs(...) call, got ${calls.length}`);
    const [call] = calls;
    if (call.arguments.length !== 4) {
      fail("_attrs", `expected _attrs(attrs, accessor, scopeId, tagName) -- 4 args, got ${call.arguments.length}`);
    }
    const [attrsObj, accessor, , tagName] = call.arguments;
    if (attrsObj.type !== "ObjectExpression") {
      fail("_attrs", `expected 1st arg to be an object expression, got ${attrsObj.type}`);
    }
    if (!attrsObj.properties.some((p) => p.type === "SpreadElement")) {
      fail("_attrs", "expected the attrs object to contain a spread element (from ...input.attrs)");
    }
    if (accessor.type !== "StringLiteral") {
      fail("_attrs", `expected 2nd arg (accessor) to be a string literal, got ${accessor.type}`);
    }
    if (tagName.type !== "StringLiteral" || tagName.value !== "a") {
      fail("_attrs", `expected 4th arg (tagName) to be the string literal "a", got ${JSON.stringify(tagName)}`);
    }
  });
});

describe("intrinsic contract: _attr_class", () => {
  test("(classExpr): 1 arg", async () => {
    const code = await compileProbe(
      "attr-class.marko",
      "export interface Input { cls: string }\n<a class=input.cls>x</a>\n",
    );
    const program = ast(code);
    if (!importedLocalNames(program).has("_attr_class")) {
      fail("_attr_class", "expected `_attr_class` to be imported by name");
    }
    const calls = findCalls(program, "_attr_class");
    if (calls.length !== 1) fail("_attr_class", `expected exactly one call, got ${calls.length}`);
    if (calls[0].arguments.length !== 1) {
      fail("_attr_class", `expected _attr_class(expr) -- 1 arg, got ${calls[0].arguments.length}`);
    }
    if (calls[0].arguments[0].type !== "MemberExpression") {
      fail("_attr_class", `expected the argument to be a member expression, got ${calls[0].arguments[0].type}`);
    }
  });
});

describe("intrinsic contract: _attr_nonce (via <html-script>)", () => {
  test("(): 0 args, imported by name", async () => {
    const code = await compileProbe(
      "html-script.marko",
      "export interface Input {}\n<html-script>console.log(1)</html-script>\n",
    );
    const program = ast(code);
    if (!importedLocalNames(program).has("_attr_nonce")) {
      fail("_attr_nonce", "expected `_attr_nonce` to be imported by name for <html-script>");
    }
    const calls = findCalls(program, "_attr_nonce");
    if (calls.length !== 1) fail("_attr_nonce", `expected exactly one call, got ${calls.length}`);
    if (calls[0].arguments.length !== 0) {
      fail("_attr_nonce", `expected _attr_nonce() to take 0 arguments, got ${calls[0].arguments.length}`);
    }
  });
});

describe("intrinsic contract: attrTag", () => {
  test("imported as `attrTag as _attrTag`; called with a single object literal containing `content`", async () => {
    const code = await compileProbe(
      "attr-tag-caller.marko",
      [
        'import PageLayout from "./page-layout.marko"',
        "<PageLayout>",
        "  <@head>",
        '    <meta name="description">',
        "  </@head>",
        "</PageLayout>",
      ].join("\n"),
      {
        "page-layout.marko":
          "export interface Input { head?: any }\n<html><head><${input.head}/></head><body>x</body></html>\n",
      },
    );
    const program = ast(code);
    const nameMap = importedNameMap(program);
    const attrTagLocal = [...nameMap.entries()].find(([, imported]) => imported === "attrTag");
    if (!attrTagLocal) fail("attrTag", 'expected an import specifier `attrTag as <local>` (imported name "attrTag")');
    const [localName] = attrTagLocal;

    const calls = findCalls(program, localName);
    if (calls.length !== 1) fail("attrTag", `expected exactly one attrTag(...) call, got ${calls.length}`);
    const [call] = calls;
    if (call.arguments.length !== 1) {
      fail("attrTag", `expected attrTag({...}) -- 1 arg, got ${call.arguments.length}`);
    }
    if (call.arguments[0].type !== "ObjectExpression") {
      fail("attrTag", `expected the argument to be an object expression, got ${call.arguments[0].type}`);
    }
    const hasContent = call.arguments[0].properties.some(
      (p) => p.type === "ObjectProperty" && p.key.type === "Identifier" && p.key.name === "content",
    );
    if (!hasContent) fail("attrTag", "expected the object literal to have a `content` property");
  });
});

describe("intrinsic contract: $global", () => {
  test('imported as `$global as _$global`; called with 0 args to bind a local `$global`', async () => {
    const code = await compileProbe(
      "global.marko",
      "export interface Input {}\n<p>${$global.foo}</p>\n",
    );
    const program = ast(code);
    const nameMap = importedNameMap(program);
    const globalLocal = [...nameMap.entries()].find(([, imported]) => imported === "$global");
    if (!globalLocal) fail("$global", 'expected an import specifier `$global as <local>` (imported name "$global")');
    const [localName] = globalLocal;

    const calls = findCalls(program, localName);
    if (calls.length !== 1) fail("$global", `expected exactly one call, got ${calls.length}`);
    if (calls[0].arguments.length !== 0) {
      fail("$global", `expected ${localName}() to take 0 arguments, got ${calls[0].arguments.length}`);
    }
  });
});
