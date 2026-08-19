/**
 * The intrinsic catalogue: which `@marko/runtime-tags/html` intrinsics this
 * transpiler understands, which it deliberately drops, and -- for the ones it
 * understands -- which translator handles each.
 *
 * This module is the SINGLE place the codegen<->runtime contract for intrinsic
 * NAMES lives. Everything else dispatches through it.
 *
 * ## Why the dispatch table exists
 *
 * Resumability (FR12) moves intrinsics from DROPPED to TRANSLATED one at a
 * time: `_scope_id`, `_scope`, `_el_resume`, `_script`, `_resume_branch`, ...
 * Each such move must be a ONE-ENTRY change here:
 *
 *   1. delete the name from `RESUME_ONLY`
 *   2. add `name: { kind, translate }` to `STATEMENT_INTRINSICS` (or
 *      `HTML_PART_INTRINSICS` for something that appears inside an `_html`
 *      template literal)
 *
 * No other module needs editing: `transpile.mjs` looks the name up, `emit.mjs`
 * appends whatever string comes back, and a translator that needs scope ids or
 * a serialization accumulator reaches them through `ctx` (see ctx.mjs).
 *
 * A name in NEITHER table is a hard `UnsupportedError` at import-scan time --
 * that is how a Marko upgrade introducing a new intrinsic fails loudly instead
 * of silently emitting wrong HTML.
 */

import { UnsupportedError } from "./errors.mjs";
import {
  translateAttrs,
  translateDynamicTag,
  translateExpr,
  translateForOf,
  translateHtmlCall,
  translateIfWrapper,
  translateTagCall,
} from "./expr.mjs";
import {
  translateResumeBranch,
  translateScope,
  translateScript,
  translateTrailers,
} from "./resume.mjs";

/**
 * Intrinsics whose entire purpose is resumability/scope-tracking bookkeeping.
 * Since marko-go never hydrates -- every page mounts fresh -- these are
 * always safe to drop. This is *not* a general optimization; it depends on
 * the "no resume" design in PLAN.md.
 *
 * FR12 note: every entry below except `_attr_nonce` is a future translator.
 * See notes/fr12-resume-findings.md §5 for the per-intrinsic mapping.
 */
export const RESUME_ONLY = new Set([
  // Guard primitives. Still "dropped", but not blindly: resume.mjs evaluates
  // them to their wave-1 constant (always 0 -- see its module header) and uses
  // that to decide whether the marker/scope they gate is emitted at all. A
  // guard expression the evaluator does not recognize is a hard error, so a
  // future non-zero reason cannot slip through as a silent drop.
  "_scope_reason",
  "_serialize_guard",
  "_serialize_if",
  // Deposits a reason for the callee. Since every value it can deposit is
  // itself a guard (i.e. 0) in wave 1, the deposit is a no-op.
  "_set_serialize_reason",
  // `_sep()` emits `<!>` between adjacent text nodes so the walker can tell
  // them apart. It takes the same shouldResume argument as _el_resume and is
  // suppressed by the same guards; no fixture in the wave-1 subset reaches an
  // unguarded one (adjacent dynamic text needs `<if>`/`<for>`), so it stays
  // dropped -- with a check in translateHtmlCall that fails loudly if an
  // UNGUARDED one ever appears.
  "_sep",
  // Client-side subscription bookkeeping: links a child scope into a parent
  // signal's closure Set. It only has an effect when the parent scope
  // serializes its closure Set, which needs a non-zero guard.
  "_subscribe",
  // Registry registration for a value/getter reachable from client code
  // (`_el`, `_hoist`). Wave 1 never produces server-side registered values
  // beyond `_script`; see contract sec 6.
  "_resume",
  "_resume_locals",
  "_id",
  // Emitted by <html-script>. It renders the CSP nonce from `$global.cspNonce`,
  // which marko-go has no equivalent for (no $global yet), so it always
  // produces the empty string here. Dropping it is exactly what the JS
  // runtime does when no nonce is configured.
  "_attr_nonce",
]);

/**
 * Intrinsics that appear in STATEMENT position (a bare expression statement,
 * or one arm of a comma sequence) inside the renderer body.
 *
 * Each entry's `translate(ctx, node)` returns either a single Go statement
 * string or an array of them; `emit.mjs` flattens both.
 *
 * `_trailers` carries real markup (the compiler defers writing closing tags,
 * e.g. `</body></html>`, past where resumability markers would go) -- same
 * reasoning as `_for_of`'s parentEndTag, not resume-only.
 */
export const STATEMENT_INTRINSICS = {
  _html: { translate: translateHtmlCall },
  // `_trailers` carries the closing `</body></html>` the compiler defers past
  // where the resume payload goes. It is NOT ordinary markup: it must land
  // AFTER the payload script, so it goes to the Writer's trailer buffer.
  _trailers: { translate: translateTrailers },
  _for_of: { translate: translateForOf },
  _if: { translate: translateIfWrapper },
  _dynamic_tag: { translate: translateDynamicTag },
  // --- resumability -------------------------------------------------------
  _scope: { translate: (ctx, node) => translateScope(ctx, node, translateExpr) },
  _script: { translate: translateScript },
  _resume_branch: { translate: translateResumeBranch },
};

/**
 * Intrinsics that appear as an INTERPOLATION inside an `_html` template
 * literal -- i.e. things that produce a fragment of the HTML stream rather
 * than a statement.
 *
 * Each entry's `translate(ctx, node)` returns a Go EXPRESSION of type string;
 * `translateHtmlCall` wraps it in `w.HTML(...)`.
 *
 * `_el_resume` is the one interpolation that is NOT in this table even though
 * it writes to the HTML stream: the Go side is `w.Marker(op, id, accessor)`, a
 * statement rather than a string expression, so translateHtmlCall handles it
 * directly. Keeping the Writer method (instead of a `runtime.Marker(...)`
 * string helper) is what lets Marker record `needsRuntime` on the same Writer
 * that will flush the payload.
 */
export const HTML_PART_INTRINSICS = {
  _escape: {
    translate: (ctx, node) =>
      `runtime.Escape(${translateExpr(ctx, node.arguments[0])})`,
  },
  _attrs: { translate: translateAttrs },
  _attr_class: {
    translate: (ctx, node) =>
      `runtime.AttrClass(${translateExpr(ctx, node.arguments[0])})`,
  },
  _attr_style: {
    translate: (ctx, node) =>
      `runtime.AttrStyle(${translateExpr(ctx, node.arguments[0])})`,
  },
  // _attr(name, value) -> ` name="escaped"`, or "" when falsy.
  _attr: {
    translate: (ctx, node) =>
      `runtime.Attr(${translateExpr(ctx, node.arguments[0])}, ${translateExpr(
        ctx,
        node.arguments[1],
      )})`,
  },
};

/**
 * Intrinsics handled structurally rather than through a dispatch table,
 * because they are recognized at a specific syntactic position rather than
 * "wherever a call appears":
 *
 *  - `_template`   the module's `export default`, matched in transpile.mjs
 *  - `_content` / `_content_resume`  a tag BODY, only valid as a tag-input
 *    property value. They differ only in whether the closure is registered
 *    for client-side resume; both wrap the same renderer function, so they
 *    translate identically to a runtime.Body.
 *  - `$global`     FR10. Imported as a NAMED intrinsic without a leading
 *    underscore; `const $global = _$global()` binds it once at the top of the
 *    renderer and every `$global.x` is a plain member read.
 *  - `attrTag`     FR11. Wraps a named section's payload on the CALLER side:
 *    `head: _attrTag({ content: _content_resume(...) })`.
 *  - `_el_resume`  FR12. Only valid as an `_html` template-literal
 *    interpolation; see HTML_PART_INTRINSICS's header for why it is not in
 *    that table.
 *  - `_scope_id` / `_peek_scope_id`  FR12. Only valid as a variable
 *    initializer (`const $scope0_id = _scope_id()`), because the Go form
 *    binds a variable the rest of the body refers to.
 *  - `_scope_with_id` / `_existing_scope`  FR12. Only valid as a `_scope`
 *    property value, where they become a `runtime.ScopeRef` (`_(id)` on the
 *    wire). Recognized by resume.mjs's translateScopeValue.
 */
export const STRUCTURAL_INTRINSICS = new Set([
  "_template",
  "_content",
  "_content_resume",
  "$global",
  "attrTag",
  "_el_resume",
  "_scope_id",
  "_peek_scope_id",
  "_scope_with_id",
  "_existing_scope",
]);

/**
 * Every intrinsic this transpiler actively understands and translates.
 * Union of the three tables above -- kept derived rather than hand-listed so a
 * dispatch entry can never drift out of the "handled" set.
 */
export const HANDLED = new Set([
  ...Object.keys(STATEMENT_INTRINSICS),
  ...Object.keys(HTML_PART_INTRINSICS),
  ...STRUCTURAL_INTRINSICS,
]);

/**
 * Assert every intrinsic the compiled module imports is one we know about.
 * Runs once, right after the import scan, so an unsupported feature fails
 * before a single line of Go is emitted.
 */
export function assertAllIntrinsicsKnown(localToIntrinsic) {
  for (const [, intrinsic] of localToIntrinsic) {
    if (!RESUME_ONLY.has(intrinsic) && !HANDLED.has(intrinsic)) {
      throw new UnsupportedError(
        `unsupported Marko feature: "${intrinsic}" is not part of the ported subset yet`,
      );
    }
  }
}

/**
 * The custom-tag "intrinsic": a `_uiButton({...})` call resolved through the
 * project registry. Not a Marko intrinsic at all, but it occupies the same
 * statement-dispatch slot, so it is exposed the same way.
 */
export const TAG_CALL = { translate: translateTagCall };
