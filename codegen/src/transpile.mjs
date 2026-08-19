import { parse } from "@babel/parser";
import * as t from "@babel/types";

/**
 * Thrown for any construct outside the supported subset. Always carries a
 * source location so failures point at real code, not this transpiler.
 */
export class UnsupportedError extends Error {
  constructor(message, node) {
    const loc = node?.loc?.start;
    super(loc ? `${message} (at ${loc.line}:${loc.column})` : message);
    this.name = "UnsupportedError";
  }
}

// Intrinsics whose entire purpose is resumability/scope-tracking bookkeeping.
// Since marko-go never hydrates -- every page mounts fresh -- these are
// always safe to drop. This is *not* a general optimization; it depends on
// the "no resume" design in PLAN.md.
const RESUME_ONLY = new Set([
  "_scope_reason",
  "_serialize_guard",
  "_serialize_if",
  "_scope_id",
  "_scope",
  "_scope_with_id",
  "_el_resume",
  "_sep",
  "_script",
  "_subscribe",
  "_resume_branch",
  "_resume",
  "_resume_locals",
  "_peek_scope_id",
  "_existing_scope",
  "_id",
]);

// Intrinsics this transpiler actively understands and translates.
const HANDLED = new Set(["_html", "_escape", "_for_of", "_if", "_template"]);

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function goStringLiteral(s) {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}

/**
 * Transpiles the html-target JS produced by @marko/compiler +
 * @marko/runtime-tags into Go source calling into the `runtime` package.
 * Only the subset described in PLAN.md is supported; anything else
 * throws UnsupportedError rather than emitting something wrong.
 *
 * @param {string} jsSource
 * @param {{goPackage: string}} opts
 * @returns {string} Go source
 */
export function transpile(jsSource, { goPackage }) {
  const ast = parse(jsSource, { sourceType: "module" });

  // 1. Map local import bindings to their intrinsic names, and split them
  //    into "drop" vs "handle" sets. Anything imported from the runtime
  //    that isn't in either list is a construct we don't yet support --
  //    fail fast at the import, before we even look at the body.
  const localToIntrinsic = new Map();
  for (const node of ast.program.body) {
    if (
      t.isImportDeclaration(node) &&
      /runtime-tags\/(debug\/)?html$/.test(node.source.value)
    ) {
      for (const spec of node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          localToIntrinsic.set(spec.local.name, spec.imported.name);
        }
      }
    }
  }
  if (localToIntrinsic.size === 0) {
    throw new UnsupportedError(
      "no import from @marko/runtime-tags/html found -- is this html-target output?",
    );
  }
  for (const [local, intrinsic] of localToIntrinsic) {
    if (!RESUME_ONLY.has(intrinsic) && !HANDLED.has(intrinsic)) {
      throw new UnsupportedError(
        `unsupported Marko feature: "${intrinsic}" is not part of the ported subset yet`,
      );
    }
  }
  const nameOf = (localName) => localToIntrinsic.get(localName);
  const isResumeOnlyCall = (node) =>
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    RESUME_ONLY.has(nameOf(node.callee.name));
  const calleeIs = (node, intrinsic) =>
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    nameOf(node.callee.name) === intrinsic;

  // 2. Find `export default _template(id, renderer, page?)`.
  const exportDefault = ast.program.body.find((n) =>
    t.isExportDefaultDeclaration(n),
  );
  if (!exportDefault || !calleeIs(exportDefault.declaration, "_template")) {
    throw new UnsupportedError(
      "expected `export default _template(...)` -- unrecognized module shape",
      exportDefault,
    );
  }
  const [, renderer] = exportDefault.declaration.arguments;
  if (
    !(t.isArrowFunctionExpression(renderer) || t.isFunctionExpression(renderer))
  ) {
    throw new UnsupportedError("template renderer is not a function", renderer);
  }
  if (renderer.params.length > 1 || (renderer.params[0] && !t.isIdentifier(renderer.params[0]))) {
    throw new UnsupportedError(
      "destructured or multiple input params are not supported yet -- use a single `input` identifier",
      renderer,
    );
  }
  const inputParamName = renderer.params[0]?.name ?? "input";
  if (!t.isBlockStatement(renderer.body)) {
    throw new UnsupportedError("expected a block-bodied renderer function", renderer);
  }

  // 3. Expression translator: JS -> Go, for the narrow set of shapes that
  //    show up in compiled Marko output (member access into `input` or a
  //    loop variable, literals, simple operators). Field access is
  //    capitalized to match Go's exported-field convention -- see the
  //    Input-struct contract in PLAN.md.
  function translateExpr(node) {
    if (t.isIdentifier(node)) {
      return node.name === inputParamName ? "input" : node.name;
    }
    if (t.isMemberExpression(node) && !node.computed) {
      const propName = node.property.name;
      if (propName === "length") {
        return `len(${translateExpr(node.object)})`;
      }
      return `${translateExpr(node.object)}.${capitalize(propName)}`;
    }
    if (t.isStringLiteral(node)) return goStringLiteral(node.value);
    if (t.isNumericLiteral(node)) return String(node.value);
    if (t.isBooleanLiteral(node)) return String(node.value);
    if (t.isNullLiteral(node)) return "nil";
    if (t.isArrayExpression(node) && node.elements.every((e) => e && !t.isSpreadElement(e))) {
      // Element type is unknown from JS alone -- see the []any contract
      // for Input slice fields in PLAN.md.
      return `[]any{${node.elements.map(translateExpr).join(", ")}}`;
    }
    if (t.isBinaryExpression(node)) {
      const op = node.operator === "===" ? "==" : node.operator === "!==" ? "!=" : node.operator;
      return `${translateExpr(node.left)} ${op} ${translateExpr(node.right)}`;
    }
    if (t.isLogicalExpression(node)) {
      return `${translateExpr(node.left)} ${node.operator} ${translateExpr(node.right)}`;
    }
    if (t.isUnaryExpression(node) && node.operator === "!") {
      return `!${translateExpr(node.argument)}`;
    }
    throw new UnsupportedError(
      `expression of type ${node.type} is not part of the ported subset yet`,
      node,
    );
  }

  // 4. `_html(arg)` -> one or more `w.HTML(...)` statements. `arg` is
  //    either a plain string (static markup) or a template literal mixing
  //    static text with `_escape(...)` (dynamic text) and resume-only
  //    markers (`_sep`, `_el_resume`), which are dropped.
  function translateHtmlCall(node) {
    const [arg] = node.arguments;
    if (t.isStringLiteral(arg)) {
      return arg.value === "" ? [] : [`w.HTML(${goStringLiteral(arg.value)})`];
    }
    if (t.isTemplateLiteral(arg)) {
      const out = [];
      arg.quasis.forEach((q, i) => {
        if (q.value.cooked) out.push(`w.HTML(${goStringLiteral(q.value.cooked)})`);
        const expr = arg.expressions[i];
        if (expr === undefined) return;
        if (calleeIs(expr, "_escape")) {
          out.push(`w.HTML(runtime.Escape(${translateExpr(expr.arguments[0])}))`);
        } else if (isResumeOnlyCall(expr)) {
          // resumability marker -- contributes nothing to a fresh mount
        } else {
          throw new UnsupportedError(
            "unsupported expression inside _html template literal -- only _escape(...) is handled",
            expr,
          );
        }
      });
      return out;
    }
    throw new UnsupportedError("_html called with a non-literal argument", node);
  }

  // 5. `_for_of(items, cb, by, scopeId, accessor, sg1, sg2, sg3,
  //    parentEndTag, singleNode)` -> runtime.ForOf(items, func(item any)
  //    {...}) followed by the parent's closing tag, if any.
  //
  // Signature confirmed against runtime-tags/src/html/writer.ts:
  //   _for_of(list, cb, by, scopeId, accessor, serializeBranch,
  //           serializeMarker, serializeStateful, parentEndTag, singleNode)
  //
  // `parentEndTag` exists because the compiler defers writing the parent
  // element's closing tag (e.g. `</ul>`) into the for-loop machinery
  // itself, rather than emitting it as a separate `_html("</ul>")` call
  // after the loop -- almost certainly so the closing tag still gets
  // written when `list` is empty/falsy. `by` (arg index 2) and
  // `singleNode` (arg index 9) are diffing/resume-only concerns, dropped
  // like everything else in RESUME_ONLY.
  function translateForOf(node) {
    const [itemsArg, cb, , , , , , , parentEndTagArg] = node.arguments;
    if (!(t.isArrowFunctionExpression(cb) || t.isFunctionExpression(cb))) {
      throw new UnsupportedError("for-of callback is not a function", node);
    }
    if (cb.params.length > 1 || (cb.params[0] && !t.isIdentifier(cb.params[0]))) {
      throw new UnsupportedError(
        "destructured for-loop parameters are not supported yet -- name the item and access fields as item.Field",
        cb,
      );
    }
    const itemName = cb.params[0]?.name ?? "_item";
    const body = translateBlockStatements(cb.body.body);
    const out = [
      `runtime.ForOf(${translateExpr(itemsArg)}, func(${itemName} any) {`,
      indent(body),
      `})`,
    ];
    if (t.isStringLiteral(parentEndTagArg) && parentEndTagArg.value !== "") {
      out.push(`w.HTML(${goStringLiteral(parentEndTagArg.value)})`);
    }
    return out.join("\n");
  }

  // 6. `_if(cb, ...)` unwraps to whatever native `if` statement is inside
  //    the callback -- the wrapper is entirely resumability bookkeeping.
  function translateIfWrapper(node) {
    const [cb] = node.arguments;
    if (!(t.isArrowFunctionExpression(cb) || t.isFunctionExpression(cb))) {
      throw new UnsupportedError("_if callback is not a function", node);
    }
    return translateBlockStatements(cb.body.body).join("\n");
  }

  function translateIfStatement(node) {
    // Go doesn't coerce int/string/nil to bool in an if-condition the way
    // JS does, so every test goes through runtime.Truthy. It's a no-op
    // for expressions that are already real Go bools (comparisons, `!x`).
    const test = `runtime.Truthy(${translateExpr(node.test)})`;
    const consequent = translateBlockStatements(
      t.isBlockStatement(node.consequent) ? node.consequent.body : [node.consequent],
    );
    let out = `if ${test} {\n${indent(consequent)}\n}`;
    if (node.alternate) {
      if (t.isIfStatement(node.alternate)) {
        out += ` else ${translateIfStatement(node.alternate)}`;
      } else {
        const alt = translateBlockStatements(
          t.isBlockStatement(node.alternate) ? node.alternate.body : [node.alternate],
        );
        out += ` else {\n${indent(alt)}\n}`;
      }
    }
    return out;
  }

  // 7. Statement-level translator, used for the renderer body and every
  //    nested block (for-of callbacks, if branches).
  function translateStatement(node) {
    if (t.isVariableDeclaration(node)) {
      const lines = [];
      for (const decl of node.declarations) {
        if (decl.init && isResumeOnlyCall(decl.init)) continue; // dropped
        if (!t.isIdentifier(decl.id)) {
          throw new UnsupportedError("destructuring assignment is not supported yet", node);
        }
        lines.push(`${decl.id.name} := ${translateExpr(decl.init)}`);
      }
      return lines;
    }
    if (t.isReturnStatement(node)) {
      // Branch-index bookkeeping from inside an `_if` callback -- not a
      // real return in the ported subset.
      if (node.argument === null || t.isNumericLiteral(node.argument)) return [];
      throw new UnsupportedError("value-returning statements are not supported yet", node);
    }
    if (t.isIfStatement(node)) {
      return [translateIfStatement(node)];
    }
    if (t.isExpressionStatement(node)) {
      const expr = node.expression;
      if (isResumeOnlyCall(expr)) return [];
      if (
        t.isLogicalExpression(expr) &&
        expr.operator === "&&" &&
        isResumeOnlyCall(expr.right)
      ) {
        return []; // `(guard) && _scope(...)` -- resumability bookkeeping
      }
      if (calleeIs(expr, "_html")) return translateHtmlCall(expr);
      if (calleeIs(expr, "_for_of")) return [translateForOf(expr)];
      if (calleeIs(expr, "_if")) return [translateIfWrapper(expr)];
      throw new UnsupportedError(
        `unsupported statement: expression of type ${expr.type}`,
        node,
      );
    }
    throw new UnsupportedError(`unsupported statement type: ${node.type}`, node);
  }

  function translateBlockStatements(stmts) {
    const out = [];
    for (const s of stmts) out.push(...translateStatement(s));
    return out;
  }

  function indent(lines) {
    return lines.map((l) => l.split("\n").map((ln) => "\t" + ln).join("\n")).join("\n");
  }

  const bodyGo = translateBlockStatements(renderer.body.body);

  return `// Code generated by marko-go/codegen. DO NOT EDIT.
package ${goPackage}

import "github.com/svallory/marko-go/runtime"

// Render renders the template into w. See input.go for the Input struct
// this expects.
func Render(w *runtime.Writer, input Input) {
${indent(bodyGo)}
}
`;
}
