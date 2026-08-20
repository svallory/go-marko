/**
 * Resumability translators (FR12 wave 1, Phase C).
 *
 * The intrinsics here used to live in `RESUME_ONLY` -- dropped wholesale,
 * because go-marko rendered pages that never hydrated. They now emit real Go,
 * so a generated page ships the same resume payload Marko's own `html`
 * renderer does, byte for byte.
 *
 * ## The model
 *
 * A resume payload has three moving parts, and the compiled JS threads them
 * through intrinsics that all key off ONE thing: the scope id.
 *
 *   scope ids   `_scope_id()` post-increments a per-RENDER counter, 1-based.
 *               The ids are wire-visible (markers, `_(id)` refs, and the
 *               payload's ascending delta encoding), so ALLOCATION ORDER is
 *               part of the contract. It is RENDER order, not source order:
 *               a body closure allocates when the callee renders it, not
 *               where it is written. That is why these are runtime calls
 *               (`w.AllocScopeID()`) and not transpile-time constants -- a
 *               transpile-time allocator cannot see that a `<@head>` body
 *               renders before the page body, or that a tag renders its body
 *               in the middle of its own markup.
 *
 *   markers     `_el_resume(scopeId, accessor, guard?)` writes
 *               `<!--M_*<id> <accessor>-->` immediately after the node it
 *               names -> `w.Marker(runtime.OpResume, id, acc)`.
 *
 *   payload     `_scope(id, {...})` accumulates serialized state and
 *               `_script(id, "regId")` accumulates client-effect entries;
 *               both land in the Writer's resume channel and flush as one
 *               `<script>` at the end of the page.
 *
 * ## Guards (contract sec 10) -- and why they are constants here
 *
 * Marko gates serialization with a caller-deposited "serialize reason":
 * `_set_serialize_reason(r)` deposits, `_scope_reason()` consume-once reads,
 * and `_serialize_if(r, key)` / `_serialize_guard(r, key)` test bit `key+1`.
 *
 * For a PAGE render the whole chain is rooted at zero and stays there:
 *
 *   - Nothing deposits a reason before the page root runs, so the root's
 *     `_scope_reason()` is `undefined` and every guard derived from it is 0.
 *   - A template deposits for its callee only via values it derived from its
 *     OWN reason (`_set_serialize_reason({1: $sg__input_class, ...})`), so a
 *     zero reason propagates as zeros.
 *   - The runtime's only other depositor is `_dynamic_tag`, which deposits
 *     `shouldResume && input !== undefined ? 1 : 0` where
 *     `shouldResume = serializeReason !== 0` -- and the compiler always
 *     passes a `_serialize_guard(...)` result there, i.e. 0.
 *
 * So every `_serialize_guard(...)` is 0 and every `_serialize_if(...)` is
 * falsy for the entire wave-1 surface. That is verified against the real
 * runtime by tracing every fixture page (see the trace evidence in the Phase C
 * report), and it is what lets these translate to Go CONSTANTS: a guarded
 * `_el_resume` emits no marker, a `(_serialize_if(...)) && _scope(...)`
 * statement is dropped, and an unguarded call emits normally.
 *
 * This is exactly the wave-1 relief the wire contract sanctions, widened from
 * "page-root templates" to "the whole tree of a page render" with the
 * propagation argument above. The moment go-marko renders an EMBEDDED template
 * (contract sec 15.5) or a caller deposits a non-zero reason, this becomes
 * wrong -- see the report's wave-2 issues.
 */

import * as t from "@babel/types";
import { UnsupportedError } from "./errors.mjs";
import { goStringLiteral } from "./names.mjs";
// Cyclic with expr.mjs (it imports the translators here, this needs its
// optional-field helper). Fine under ESM live bindings as long as neither side
// touches the other at module-evaluation time -- only inside function bodies.
import { absentIfZero } from "./expr.mjs";

// ---------------------------------------------------------------------------
// Guard evaluation
// ---------------------------------------------------------------------------

/**
 * Statically evaluate a serialize guard/reason expression to its wave-1 value.
 *
 * Returns `0` for anything derived from a serialize reason (see the module
 * header for why that is always the answer here), `undefined` when the
 * expression is not a guard at all.
 *
 * Recognized shapes, all of which the compiler emits:
 *
 *   _serialize_guard($reason, 3)      direct call
 *   _serialize_if($reason, 3)         direct call
 *   $sg__input_href                   a const bound to one of the above
 *   ($sg__x) || ($sg__y)              a union of guards (`_if`'s branch guard)
 *   0 / 1                             a literal the compiler inlined
 */
export function evalGuard(ctx, node) {
  if (node === undefined || node === null) return undefined;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isIdentifier(node)) {
    return ctx.resume.guardConsts.has(node.name)
      ? ctx.resume.guardConsts.get(node.name)
      : undefined;
  }
  const intrinsic = calleeIntrinsicName(ctx, node);
  if (intrinsic === "_serialize_guard") return 0;
  if (intrinsic === "_serialize_if") return 0;
  if (intrinsic === "_scope_reason") return 0;
  if (t.isLogicalExpression(node) && (node.operator === "||" || node.operator === "&&")) {
    const l = evalGuard(ctx, node.left);
    const r = evalGuard(ctx, node.right);
    if (l === undefined || r === undefined) return undefined;
    // Both sides are 0 in wave 1, so either operator yields 0. Written out
    // rather than hardcoded so a future non-zero reason surfaces here.
    return node.operator === "||" ? l || r : l && r;
  }
  return undefined;
}

/**
 * A guard ARGUMENT decides whether a marker/scope is emitted at all. Absent
 * (the compiler omitted the parameter) means "always emit"; present means
 * "emit iff truthy", which in wave 1 is never.
 */
export function guardAllowsEmit(ctx, node) {
  if (node === undefined) return true;
  const value = evalGuard(ctx, node);
  if (value === undefined) {
    throw new UnsupportedError(
      "unrecognized serialize-guard expression -- the resume translators only understand guards derived from _scope_reason()",
      node,
    );
  }
  return Boolean(value);
}

/**
 * Is this a `(guard) && <expr>` whose guard is statically off? Those statements
 * (`(_serialize_if(...)) && _scope(...)`) drop entirely.
 */
export function isDisabledGuardedStatement(ctx, node) {
  if (!t.isLogicalExpression(node) || node.operator !== "&&") return false;
  if (!isGuardExpression(ctx, node.left)) return false;
  const value = evalGuard(ctx, node.left);
  return value !== undefined && !value;
}

/**
 * Record `const $sg__x = _serialize_guard(...)` style bindings so a later
 * reference to `$sg__x` evaluates to the same constant. Returns true when the
 * declarator was a guard binding (and therefore emits no Go).
 *
 * Only an initializer that is ITSELF a guard construct counts. A bare literal
 * does NOT -- `let count = 0` is a `<let>` state variable, and treating its `0`
 * as a guard would silently delete the template's state.
 */
export function recordGuardConst(ctx, decl) {
  if (!t.isIdentifier(decl.id)) return false;
  if (!isGuardExpression(ctx, decl.init)) return false;
  const value = evalGuard(ctx, decl.init);
  if (value === undefined) return false;
  ctx.resume.guardConsts.set(decl.id.name, value);
  return true;
}

/**
 * Is this expression rooted in the serialize-guard machinery, as opposed to
 * something that merely happens to evaluate to a number? Bare literals are
 * meaningful as guards only in guard POSITION (an argument slot), never as the
 * thing that decides an expression is a guard.
 */
function isGuardExpression(ctx, node) {
  if (!node) return false;
  const intrinsic = calleeIntrinsicName(ctx, node);
  if (
    intrinsic === "_serialize_guard" ||
    intrinsic === "_serialize_if" ||
    intrinsic === "_scope_reason"
  ) {
    return true;
  }
  if (t.isIdentifier(node)) return ctx.resume.guardConsts.has(node.name);
  if (t.isLogicalExpression(node)) {
    return isGuardExpression(ctx, node.left) || isGuardExpression(ctx, node.right);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scope ids
// ---------------------------------------------------------------------------

/**
 * `const $scopeN_id = _scope_id()` -> `scopeN := w.AllocScopeID()`.
 *
 * The Go name is derived from the JS binding rather than invented, so a later
 * `_scope($scopeN_id, ...)` in the same body resolves by plain identifier
 * lookup. Names are sanitized (`$` is not a Go identifier character) and
 * recorded on ctx so `scopeIdExpr` can find them.
 */
export function translateScopeIdDecl(ctx, decl) {
  const goName = goScopeVarName(decl.id.name);
  ctx.resume.scopeVars.set(decl.id.name, goName);
  ctx.resume.used = true;
  return `${goName} := w.AllocScopeID()`;
}

/** `const $childScope = _peek_scope_id()` -> `x := w.PeekScopeID()`. */
export function translatePeekScopeIdDecl(ctx, decl) {
  const goName = goScopeVarName(decl.id.name);
  ctx.resume.scopeVars.set(decl.id.name, goName);
  ctx.resume.used = true;
  return `${goName} := w.PeekScopeID()`;
}

/**
 * Drop the binding from `X := w.AllocScopeID()` when nothing in the body ever
 * reads `X`, leaving the bare call.
 *
 * The CALL cannot be dropped -- it advances the render's scope-id counter, and
 * every later id (and therefore every marker, `_(id)` reference and payload
 * delta) shifts if it is missing. Only the Go variable is unnecessary, and Go
 * rejects an unused one outright, so this is required rather than cosmetic.
 * It happens here, at assembly, because whether a scope id is read is only
 * known once the entire body is translated: a template can allocate a scope
 * purely for ordering (every icon tag does) and never mention it again.
 */
export function dropUnusedScopeVars(ctx, bodyGo) {
  if (ctx.resume.scopeVars.size === 0) return bodyGo;
  const joined = bodyGo.join("\n");
  const unused = new Set();
  for (const goName of ctx.resume.scopeVars.values()) {
    const uses = joined.match(new RegExp(`\\b${goName}\\b`, "g"));
    if (uses && uses.length === 1) unused.add(goName);
  }
  if (unused.size === 0) return bodyGo;
  // Entries can themselves be MULTI-LINE (a body closure is one string), so
  // the rewrite walks lines inside each entry rather than whole entries.
  const rewriteLine = (line) => {
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*) := (w\.(?:Alloc|Peek)ScopeID\(\))$/.exec(line);
    return m && unused.has(m[2]) ? `${m[1]}${m[3]}` : line;
  };
  return bodyGo.map((entry) => entry.split("\n").map(rewriteLine).join("\n"));
}

/** `$scope0_id` / `$childScope` -> the Go int variable holding that scope id. */
export function scopeIdExpr(ctx, node) {
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isIdentifier(node)) {
    const goName = ctx.resume.scopeVars.get(node.name);
    if (goName) return goName;
  }
  throw new UnsupportedError(
    "expected a scope id bound by _scope_id()/_peek_scope_id()",
    node,
  );
}

/**
 * Marko names scope-id bindings `$scope0_id`, `$scope1_id`, `$childScope`.
 * `$` is not legal in a Go identifier, so it is dropped; the rest is already a
 * valid Go name and is left alone so the generated code stays readable next to
 * the compiled JS it mirrors.
 */
function goScopeVarName(jsName) {
  const cleaned = jsName.replace(/\$/g, "");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `s${cleaned}`;
}

// ---------------------------------------------------------------------------
// Markers, scripts, scopes
// ---------------------------------------------------------------------------

/**
 * `_el_resume(scopeId, "acc", guard?)` -> `runtime.Marker(...)` as an HTML
 * fragment expression, or `""` when the guard suppresses it.
 *
 * It appears inside an `_html` template literal, so it must be an EXPRESSION;
 * the Writer method is `w.Marker(...)`, which writes directly, so the emitting
 * side (translateHtmlCall) special-cases this one to a statement. See
 * `elResumeStatement`.
 */
export function elResumeStatement(ctx, node) {
  if (!guardAllowsEmit(ctx, node.arguments[2])) return null;
  const [scopeArg, accessorArg] = node.arguments;
  if (!t.isStringLiteral(accessorArg)) {
    throw new UnsupportedError("_el_resume accessor is not a string literal", node);
  }
  ctx.resume.used = true;
  return `w.Marker(runtime.OpResume, ${scopeIdExpr(ctx, scopeArg)}, ${goStringLiteral(accessorArg.value)})`;
}

/** `_script(scopeId, "regId")` -> `w.AddScript("regId", scopeId)`. */
export function translateScript(ctx, node) {
  const [scopeArg, regArg] = node.arguments;
  if (!t.isStringLiteral(regArg)) {
    throw new UnsupportedError("_script registry id is not a string literal", node);
  }
  ctx.resume.used = true;
  ctx.resume.registryIds.add(regArg.value);
  return `w.AddScript(${goStringLiteral(regArg.value)}, ${scopeIdExpr(ctx, scopeArg)})`;
}

/**
 * `_scope(scopeId, { k: v, ... })` -> `w.AddScope(id, runtime.ScopeStateOf(...))`.
 *
 * Key ORDER is preserved as written: ScopeStateOf records insertion order and
 * the serializer applies JS enumeration order (integer-like keys first) on top,
 * so the Go side reproduces `for (const key in obj)` exactly.
 *
 * A property whose value is a statically-off guard (`k: (_serialize_if(...)) &&
 * expr`) is DROPPED rather than emitted as `false`: that is what JS produces
 * too, since `_serialize_if` returns `undefined` and the serializer omits an
 * undefined property.
 */
export function translateScope(ctx, node, translateValue) {
  const [scopeArg, objArg] = node.arguments;
  if (!t.isObjectExpression(objArg)) {
    throw new UnsupportedError("_scope called with a non-literal state object", node);
  }
  ctx.resume.used = true;
  const pairs = [];
  for (const prop of objArg.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) {
      throw new UnsupportedError("unsupported property in _scope state", prop);
    }
    const key = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : t.isNumericLiteral(prop.key)
          ? String(prop.key.value)
          : null;
    if (key === null) throw new UnsupportedError("unsupported _scope key", prop.key);
    // `k: (guard) && value` with the guard off -> the property never exists.
    if (isDisabledGuardedStatement(ctx, prop.value)) continue;
    pairs.push(`${goStringLiteral(key)}, ${translateScopeValue(ctx, prop.value, translateValue)}`);
  }
  const id = scopeIdExpr(ctx, scopeArg);
  if (pairs.length === 0) {
    // `_scope(id, {})` still marks the scope as existing (and the render as
    // needing the runtime) even though an empty partial serializes to nothing.
    return `w.TouchScope(${id})`;
  }
  return `w.AddScope(${id}, runtime.ScopeStateOf(${pairs.join(", ")}))`;
}

/**
 * One `_scope` property value. Scope-valued intrinsics become `runtime.Scope`
 * / `w.TouchScope` (both `ScopeRef`, which the serializer writes as `_(id)`);
 * anything else falls through to the ordinary expression translator.
 */
function translateScopeValue(ctx, node, translateValue) {
  const intrinsic = calleeIntrinsicName(ctx, node);
  if (intrinsic === "_scope_with_id") {
    return `runtime.Scope(${scopeIdExpr(ctx, node.arguments[0])})`;
  }
  if (intrinsic === "_existing_scope") {
    // `_existing_scope(id)` is `writeScope(id, {})` -- it BOTH registers the
    // scope and evaluates to a reference to it.
    return `w.TouchScope(${scopeIdExpr(ctx, node.arguments[0])})`;
  }
  // An optional input field that was never passed must serialize as
  // `undefined` -- dropped from the object -- not as its Go zero value.
  return absentIfZero(ctx, node, translateValue(ctx, node));
}

/** `_trailers("</body></html>")` -> `w.Trailer("...")`. */
export function translateTrailers(ctx, node) {
  const [arg] = node.arguments;
  if (!t.isStringLiteral(arg)) {
    throw new UnsupportedError("_trailers called with a non-literal argument", node);
  }
  ctx.resume.used = true;
  return arg.value === "" ? [] : [`w.Trailer(${goStringLiteral(arg.value)})`];
}

/**
 * `_resume_branch(scopeId)` records the CLOSEST enclosing resumed branch on a
 * scope (`writeScope(id, {ClosestBranchId: branchId})`), and only when the
 * render is actually inside one -- which requires `<await>`, out-of-order
 * streaming, or a `_dynamic_tag` rendering a resumable component branch.
 *
 * None of that exists in the wave-1 subset (no async, no `<await>`, guards
 * uniformly off so `withBranchId` is never entered), so the call is a
 * guaranteed no-op and emits nothing. Revisit with the control-flow /
 * streaming waves.
 */
export function translateResumeBranch() {
  return [];
}

// ---------------------------------------------------------------------------

/** Local helper mirroring expr.mjs's calleeIntrinsic without importing it. */
function calleeIntrinsicName(ctx, node) {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return undefined;
  return ctx.localToIntrinsic.get(node.callee.name);
}
