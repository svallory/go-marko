/**
 * Minimal Go type inference over the compiled JS.
 *
 * The compiled JS carries no types, but the template's own
 * `export interface Input` does, and inputstruct.mjs has already mapped it to
 * Go types -- including named structs for inline object types. That is enough
 * to type the places where it matters: a for-of loop's element, a tag input
 * field, and an `<if>` test on a pointer.
 *
 * `input.events` is known to be `[]CounterInputEvents`, so the loop can be
 * emitted as `runtime.ForOfIndexed(input.events, func(event CounterInputEvents, i int))`
 * -- which makes `event.Label` resolve to a real struct field instead of
 * needing a runtime type assertion. The loop variable's type is then in scope
 * for nested loops (`for|tag| of=event.tags`), so inference composes.
 *
 * Everything here is best-effort: an unknown type is `null`, and every
 * consumer has a working `any`-shaped fallback (ForOfAny et al). We never
 * guess -- a wrong Go type would be a compile error at best and wrong output
 * at worst.
 *
 * All state lives on `ctx` (typeScopes, inputFieldTypes, structFieldTypes,
 * globalsBinding/globalsEntry); nothing here is stateful on its own.
 */

import * as t from "@babel/types";
import { UnsupportedError } from "./errors.mjs";
import { capitalize } from "./names.mjs";

/** Go type name generated for `Marko.Global` -- must match globals.mjs. */
export const GLOBALS_TYPE = "Globals";

/**
 * Go name for the request context inside a generated render func. The JS
 * binding is `$global`, which is not a legal Go identifier, so it is
 * renamed. `markoGlobal` is prefixed rather than plain `global` so a
 * template that declares its OWN variable named `global` (legal Marko, and
 * translated to a Go local under its own name) cannot shadow the request
 * context.
 */
export const GLOBALS_VAR = "markoGlobal";

/** Innermost-first lookup through the lexical stack of loop-variable types. */
export function lookupLocalType(ctx, name) {
  for (let i = ctx.typeScopes.length - 1; i >= 0; i--) {
    if (ctx.typeScopes[i].has(name)) return ctx.typeScopes[i].get(name);
  }
  return null;
}

/** Run `fn` with `types` pushed as the innermost scope, always popping after. */
export function withTypeScope(ctx, types, fn) {
  ctx.typeScopes.push(new Map(types));
  try {
    return fn();
  } finally {
    ctx.typeScopes.pop();
  }
}

/**
 * Best-effort Go type of a JS expression, or null when unknown.
 * Deliberately covers only what the fixture space needs: the input
 * identifier, member access into Input/nested structs, and loop variables.
 */
export function inferGoType(ctx, node) {
  if (t.isIdentifier(node)) {
    if (node.name === ctx.inputParamName) return ctx.structName;
    // `$global` is typed by the project's generated Globals struct, which
    // is a different package's type -- its FIELD types are what matter
    // here, so it gets a sentinel that only the member branch consumes.
    if (ctx.globalsBinding !== null && node.name === ctx.globalsBinding) return GLOBALS_TYPE;
    return lookupLocalType(ctx, node.name);
  }
  // OptionalMemberExpression (`input.head?.content`) reads identically:
  // Go has no optional chaining, and the only place the compiler emits it
  // is behind a nil test we've already translated (or inside a dropped
  // resume-only call).
  if (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    !node.computed &&
    t.isIdentifier(node.property)
  ) {
    if (node.property.name === "length") return "int"; // len(...)
    const objType = inferGoType(ctx, node.object);
    if (!objType) return null;
    const fieldName = capitalize(node.property.name);
    if (objType === GLOBALS_TYPE) {
      return ctx.globalsEntry?.fieldTypes?.get(fieldName) ?? null;
    }
    if (objType === ctx.structName) return ctx.inputFieldTypes.get(fieldName) ?? null;
    // A pointer field (an optional attr tag, FR11) is dereferenced with
    // the same `.Field` syntax in Go, so the pointee's fields are what a
    // member read resolves against.
    const base = objType.startsWith("*") ? objType.slice(1) : objType;
    return ctx.structFieldTypes.get(base)?.get(fieldName) ?? null;
  }
  return null;
}

/**
 * Whether an expression is ALREADY a Go `string`, so passing it to a
 * string-typed field needs no runtime.String coercion. Deliberately
 * conservative: an unknown expression returns false and gets wrapped,
 * which is always type-correct (runtime.String of a string is identity).
 */
export function isStringTyped(ctx, node) {
  if (t.isStringLiteral(node)) return true;
  // `a + b` over strings is a Go string; over anything else the binary
  // translation wouldn't have compiled anyway.
  if (t.isBinaryExpression(node) && node.operator === "+") {
    return isStringTyped(ctx, node.left) && isStringTyped(ctx, node.right);
  }
  return inferGoType(ctx, node) === "string";
}

/** `[]T` -> `T`; anything else (including `[]any`) -> null. */
export function sliceElemType(goType) {
  if (!goType || !goType.startsWith("[]")) return null;
  const elem = goType.slice(2);
  return elem === "any" ? null : elem;
}

/**
 * Whether an expression is already a Go `bool`, which decides whether a
 * `&&`/`||` can stay a native Go operator or has to become the
 * value-returning runtime.And/runtime.OrValue. Comparisons, negations and
 * boolean literals are bool; a string, a number, or an unknown expression
 * is not.
 */
export function isBooleanShaped(ctx, node) {
  if (t.isBooleanLiteral(node)) return true;
  if (t.isUnaryExpression(node) && node.operator === "!") return true;
  if (t.isBinaryExpression(node)) {
    return ["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"].includes(
      node.operator,
    );
  }
  if (t.isLogicalExpression(node) && node.operator !== "??") {
    return isBooleanShaped(ctx, node.left) && isBooleanShaped(ctx, node.right);
  }
  if (t.isParenthesizedExpression?.(node)) return isBooleanShaped(ctx, node.expression);
  return inferGoType(ctx, node) === "bool";
}

/**
 * Resolve (and memoize on ctx) the project's generated Globals type. Looked up
 * LAZILY on first use so a project without a global.d.ts still generates every
 * template that doesn't read `$global`.
 */
export function useGlobals(ctx, node) {
  if (ctx.globalsEntry) return ctx.globalsEntry;
  const entry = ctx.resolveGlobals();
  if (!entry) {
    throw new UnsupportedError(
      "`$global` is used but the project declares no request context -- add a `global.d.ts` with `declare global { namespace Marko { interface Global { /* fields */ } } }` under the generate root, and marko-go will generate the Globals struct next to it",
      node,
    );
  }
  ctx.globalsEntry = entry;
  return entry;
}
