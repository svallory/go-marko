/**
 * Expression translation: JS -> Go, for the narrow set of shapes that show up
 * in compiled Marko output, plus the per-intrinsic translators that produce Go
 * expressions or statements from a specific intrinsic call.
 *
 * Everything takes `ctx` first (see ctx.mjs) and reaches state only through it.
 *
 * Note on module cycles: this module imports the dispatch tables from
 * intrinsics.mjs, which in turn imports these translators. That cycle is fine
 * under ESM live bindings -- neither module touches the other's exports at
 * module-evaluation time, only inside function bodies.
 */

import * as t from "@babel/types";
import { UnsupportedError } from "./errors.mjs";
import { capitalize, goStringLiteral } from "./names.mjs";
import { goFieldName } from "./inputstruct.mjs";
import { indent } from "./emit.mjs";
import {
  GLOBALS_VAR,
  inferGoType,
  isBooleanShaped,
  isStringTyped,
  sliceElemType,
  withTypeScope,
} from "./infer.mjs";

// ---------------------------------------------------------------------------
// Call-shape predicates. All of them key off ctx's binding tables rather than
// the local identifier the compiler happened to pick.
// ---------------------------------------------------------------------------

/** The intrinsic name a local binding refers to, or undefined. */
export const intrinsicOf = (ctx, localName) => ctx.localToIntrinsic.get(localName);

/** Is `node` a call to the intrinsic named `intrinsic`? */
export function calleeIs(ctx, node, intrinsic) {
  return (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    intrinsicOf(ctx, node.callee.name) === intrinsic
  );
}

/** The intrinsic name a call expression invokes, or undefined. */
export function calleeIntrinsic(ctx, node) {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return undefined;
  return intrinsicOf(ctx, node.callee.name);
}

/** A call to a custom tag imported from another `.marko` file. */
export function isTagCall(ctx, node) {
  return (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    ctx.localToTag.has(node.callee.name)
  );
}

/** `_content(...)` or `_content_resume(...)` -- a tag body closure. */
export function isContentCall(ctx, node) {
  return calleeIs(ctx, node, "_content") || calleeIs(ctx, node, "_content_resume");
}

// ---------------------------------------------------------------------------
// Core expression translator
// ---------------------------------------------------------------------------

export function translateExpr(ctx, node) {
  if (t.isIdentifier(node)) {
    if (node.name === ctx.inputParamName) return "input";
    if (ctx.globalsBinding !== null && node.name === ctx.globalsBinding) return GLOBALS_VAR;
    if (node.name === "undefined") return "nil";
    const modConst = ctx.moduleConsts.get(node.name);
    return modConst ?? node.name;
  }
  // Optional chaining (`input.head?.content`) translates as a PLAIN member
  // access: Go has no `?.`, and the compiler only emits it where the value
  // is already guarded (inside an `if (input.head)` branch) or inside a
  // resume-only call that gets dropped whole.
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (node.computed) {
      // `variants[key]` -- a Go map/slice index. Identical syntax.
      return `${translateExpr(ctx, node.object)}[${translateExpr(ctx, node.property)}]`;
    }
    const propName = node.property.name;
    if (propName === "length") {
      return `len(${translateExpr(ctx, node.object)})`;
    }
    return `${translateExpr(ctx, node.object)}.${capitalize(propName)}`;
  }
  if (t.isStringLiteral(node)) return goStringLiteral(node.value);
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isBooleanLiteral(node)) return String(node.value);
  if (t.isNullLiteral(node)) return "nil";
  if (
    t.isArrayExpression(node) &&
    node.elements.every((e) => e && !t.isSpreadElement(e))
  ) {
    // Element type is unknown from JS alone -- see the []any contract
    // for Input slice fields in PLAN.md. runtime.AttrClass accepts
    // []any, which is what makes `class=[a, b, c]` work.
    return `[]any{${node.elements.map((e) => translateExpr(ctx, e)).join(", ")}}`;
  }
  if (t.isObjectExpression(node)) {
    return translateObjectAsMap(ctx, node);
  }
  if (t.isBinaryExpression(node)) {
    const op =
      node.operator === "===" ? "==" : node.operator === "!==" ? "!=" : node.operator;
    return `${translateExpr(ctx, node.left)} ${op} ${translateExpr(ctx, node.right)}`;
  }
  if (t.isLogicalExpression(node)) {
    if (node.operator === "??") {
      // Go has no nullish coalescing and no "unset" for a struct field.
      // runtime.Or substitutes the zero value as the "absent" test; the
      // divergence from JS (where `""` and `0` are NOT nullish) is
      // documented on runtime.Or itself.
      return `runtime.Or(${translateExpr(ctx, node.left)}, ${translateExpr(ctx, node.right)})`;
    }
    // JS `&&`/`||` are NOT boolean operators: they return one of their
    // OPERANDS. That's load-bearing in value position -- e.g. a class array
    // entry `i === 0 && "bg-accent/50 font-medium"`, which is either `false`
    // (skipped by AttrClass) or the class string, never a bool.
    //
    // Go's `&&`/`||` only accept and produce bools, so the operand-returning
    // form goes through runtime.And / runtime.OrValue, which are exact JS
    // semantics over `any`. When BOTH operands are already boolean-shaped
    // (comparisons, negations, boolean literals) the two agree, and the
    // plain Go operator is emitted -- it reads better and keeps `<if=a && b>`
    // tests usable as native conditions.
    if (isBooleanShaped(ctx, node.left) && isBooleanShaped(ctx, node.right)) {
      return `${translateExpr(ctx, node.left)} ${node.operator} ${translateExpr(ctx, node.right)}`;
    }
    const fn = node.operator === "&&" ? "runtime.And" : "runtime.OrValue";
    return `${fn}(${translateExpr(ctx, node.left)}, ${translateExpr(ctx, node.right)})`;
  }
  if (t.isUnaryExpression(node) && node.operator === "!") {
    return `!${translateExpr(ctx, node.argument)}`;
  }
  if (t.isConditionalExpression(node)) {
    throw new UnsupportedError(
      "the ternary operator has no Go expression equivalent -- rewrite it as an <if>/<else> in the template",
      node,
    );
  }
  throw new UnsupportedError(
    `expression of type ${node.type} is not part of the ported subset yet`,
    node,
  );
}

/**
 * ObjectExpression -> `map[string]any{...}`. Used for `attrs={...}` values
 * and any other free-standing object. Keys become string literals
 * (identifier keys use their own name). All-string values collapse to
 * `map[string]string`, which is what module-level lookup tables like
 * `variants`/`sizes` need so that `variants[k]` is a usable Go string.
 */
export function translateObjectAsMap(ctx, node) {
  const entries = [];
  let allStrings = node.properties.length > 0;
  for (const prop of node.properties) {
    if (t.isSpreadElement(prop)) {
      throw new UnsupportedError(
        "object spread is only supported inside _attrs(...)",
        prop,
      );
    }
    if (!t.isObjectProperty(prop) || prop.computed) {
      throw new UnsupportedError(
        "only plain string/identifier-keyed object properties are supported",
        prop,
      );
    }
    const key = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : null;
    if (key === null) {
      throw new UnsupportedError("unsupported object key", prop.key);
    }
    if (!t.isStringLiteral(prop.value)) allStrings = false;
    entries.push(`${goStringLiteral(key)}: ${translateExpr(ctx, prop.value)}`);
  }
  const mapType = allStrings ? "map[string]string" : "map[string]any";
  if (entries.length === 0) return "map[string]any{}";
  return `${mapType}{\n${entries.map((e) => "\t" + e + ",").join("\n")}\n}`;
}

/**
 * An `if` condition. Normally runtime.Truthy (JS coercion over `any`), but
 * a POINTER-typed test becomes a native `x != nil` -- that's the
 * `<if=input.head>` guard on an optional attr tag (FR11), where nil means
 * "section not passed".
 *
 * runtime.Truthy handles a nil pointer correctly too (it reflects on
 * nil-ness precisely so untyped cases work), so this is readability plus
 * defense in depth rather than the only thing keeping the answer right.
 */
export function translateTest(ctx, node) {
  const type = inferGoType(ctx, node);
  const go = translateExpr(ctx, node);
  if (type && type.startsWith("*")) return `${go} != nil`;
  return `runtime.Truthy(${go})`;
}

// ---------------------------------------------------------------------------
// Intrinsic translators. Registered in intrinsics.mjs's dispatch tables.
// ---------------------------------------------------------------------------

/**
 * `_html(arg)` -> one or more `w.HTML(...)` statements. `arg` is either a
 * plain string (static markup) or a template literal mixing static text with
 * dynamic interpolations. Each interpolation is dispatched through
 * HTML_PART_INTRINSICS; resume-only markers (`_el_resume`, `_sep`,
 * `_attr_nonce`) are dropped.
 */
export function translateHtmlCall(ctx, node) {
  // Deferred import avoids touching the cyclic module's exports at init time.
  const { HTML_PART_INTRINSICS, RESUME_ONLY } = intrinsicTables();
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
      const intrinsic = calleeIntrinsic(ctx, expr);
      const handler = intrinsic && HTML_PART_INTRINSICS[intrinsic];
      if (handler) {
        out.push(`w.HTML(${handler.translate(ctx, expr)})`);
      } else if (intrinsic && RESUME_ONLY.has(intrinsic)) {
        // resumability marker -- contributes nothing to a fresh mount
      } else {
        throw new UnsupportedError(
          "unsupported expression inside _html template literal",
          expr,
        );
      }
    });
    return out;
  }
  throw new UnsupportedError("_html called with a non-literal argument", node);
}

/**
 * `_attrs({href, class, ...input.attrs}, tagName, scopeId, elementName)`
 * -> `runtime.Attrs(runtime.A{"href", ...}, ..., input.Attrs)`.
 *
 * Signature per runtime-tags/src/html/attrs.ts: only the first argument
 * carries data; the rest are element/scope identifiers used to register
 * resume state, which marko-go drops. Property ORDER matters (it decides
 * attribute order in the output) and so does spread position (later
 * entries win), so the items are passed positionally and runtime.Attrs
 * does the merge.
 */
export function translateAttrs(ctx, node) {
  const [objArg] = node.arguments;
  if (!t.isObjectExpression(objArg)) {
    // A bare expression (e.g. `_attrs(input.attrs, ...)`) is still a
    // valid single spread item.
    return `runtime.Attrs(${translateExpr(ctx, objArg)})`;
  }
  const items = [];
  for (const prop of objArg.properties) {
    if (t.isSpreadElement(prop)) {
      // `...input.attrs` -- a map[string]any spread; runtime.Attrs
      // expands it with sorted keys for deterministic output.
      items.push(translateExpr(ctx, prop.argument));
      continue;
    }
    if (!t.isObjectProperty(prop) || prop.computed) {
      throw new UnsupportedError("unsupported property inside _attrs", prop);
    }
    const key = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : null;
    if (key === null) throw new UnsupportedError("unsupported _attrs key", prop.key);
    items.push(
      `runtime.A{Name: ${goStringLiteral(key)}, Value: ${translateExpr(ctx, prop.value)}}`,
    );
  }
  return `runtime.Attrs(${items.join(", ")})`;
}

/**
 * `_for_of(items, cb, by, scopeId, accessor, sg1, sg2, sg3, parentEndTag,
 * singleNode)` -> runtime.ForOf(items, func(item any) {...}) followed by the
 * parent's closing tag, if any.
 *
 * Signature confirmed against runtime-tags/src/html/writer.ts:
 *   _for_of(list, cb, by, scopeId, accessor, serializeBranch,
 *           serializeMarker, serializeStateful, parentEndTag, singleNode)
 *
 * `parentEndTag` exists because the compiler defers writing the parent
 * element's closing tag (e.g. `</ul>`) into the for-loop machinery itself,
 * rather than emitting it as a separate `_html("</ul>")` call after the loop
 * -- almost certainly so the closing tag still gets written when `list` is
 * empty/falsy. `by` (arg index 2) and `singleNode` (arg index 9) are
 * diffing/resume-only concerns, dropped like everything else in RESUME_ONLY.
 */
export function translateForOf(ctx, node) {
  const [itemsArg, cb, , , , , , , parentEndTagArg] = node.arguments;
  if (!(t.isArrowFunctionExpression(cb) || t.isFunctionExpression(cb))) {
    throw new UnsupportedError("for-of callback is not a function", node);
  }
  // `<for|item| of=…>` gives one param; `<for|item, i| of=…>` gives two
  // (the index). Marko allows a third (the whole list), which nothing in
  // the ported subset needs yet.
  if (cb.params.length > 2 || cb.params.some((p) => !t.isIdentifier(p))) {
    throw new UnsupportedError(
      "destructured for-loop parameters are not supported yet -- name the item and access fields as item.Field",
      cb,
    );
  }
  const itemName = cb.params[0]?.name ?? "_item";
  const indexName = cb.params[1]?.name ?? null;

  // Type the loop variable from the source expression when we can: an
  // `input.events` typed `[]CounterInputEvents` yields a callback taking a
  // concrete CounterInputEvents, so `event.Label` type-checks. Otherwise
  // fall back to the reflective *Any runtime helpers over `any`.
  const elemType = sliceElemType(inferGoType(ctx, itemsArg));
  const goItemType = elemType ?? "any";
  const fnName = elemType
    ? indexName
      ? "runtime.ForOfIndexed"
      : "runtime.ForOf"
    : indexName
      ? "runtime.ForOfIndexedAny"
      : "runtime.ForOfAny";

  // The loop variable's type is in scope for the body only, so nested
  // loops over a field of the item infer correctly and siblings don't leak.
  const body = withTypeScope(
    ctx,
    [[itemName, goItemType], ...(indexName ? [[indexName, "int"]] : [])],
    () => translateBlockStatements(ctx, cb.body.body),
  );

  const params = indexName
    ? `${itemName} ${goItemType}, ${indexName} int`
    : `${itemName} ${goItemType}`;
  const out = [
    `${fnName}(${translateExpr(ctx, itemsArg)}, func(${params}) {`,
    indent(body),
    `})`,
  ];
  if (t.isStringLiteral(parentEndTagArg) && parentEndTagArg.value !== "") {
    out.push(`w.HTML(${goStringLiteral(parentEndTagArg.value)})`);
  }
  return out.join("\n");
}

/**
 * `_if(cb, ...)` unwraps to whatever native `if` statement is inside the
 * callback -- the wrapper is entirely resumability bookkeeping.
 */
export function translateIfWrapper(ctx, node) {
  const [cb] = node.arguments;
  if (!(t.isArrowFunctionExpression(cb) || t.isFunctionExpression(cb))) {
    throw new UnsupportedError("_if callback is not a function", node);
  }
  return translateBlockStatements(ctx, cb.body.body).join("\n");
}

export function translateIfStatement(ctx, node) {
  // Go doesn't coerce int/string/nil to bool in an if-condition the way
  // JS does, so every test goes through runtime.Truthy. It's a no-op
  // for expressions that are already real Go bools (comparisons, `!x`).
  const test = translateTest(ctx, node.test);
  const consequent = translateBlockStatements(
    ctx,
    t.isBlockStatement(node.consequent) ? node.consequent.body : [node.consequent],
  );
  let out = `if ${test} {\n${indent(consequent)}\n}`;
  if (node.alternate) {
    if (t.isIfStatement(node.alternate)) {
      out += ` else ${translateIfStatement(ctx, node.alternate)}`;
    } else {
      const alt = translateBlockStatements(
        ctx,
        t.isBlockStatement(node.alternate) ? node.alternate.body : [node.alternate],
      );
      out += ` else {\n${indent(alt)}\n}`;
    }
  }
  return out;
}

/**
 * `_content(id, renderer, parentScopeId)` / `_content_resume(...)` -> a
 * runtime.Body closure. This is a <tag> body: the caller decides where (and
 * whether) it renders. The `w` in scope is captured by the closure parameter
 * so nested bodies never see a stale writer.
 */
export function translateContent(ctx, node) {
  const [, renderer] = node.arguments;
  if (!(t.isArrowFunctionExpression(renderer) || t.isFunctionExpression(renderer))) {
    throw new UnsupportedError("_content body is not a function", node);
  }
  if (!t.isBlockStatement(renderer.body)) {
    throw new UnsupportedError("expected a block-bodied _content renderer", renderer);
  }
  const body = translateBlockStatements(ctx, renderer.body.body);
  return `func(w *runtime.Writer) {\n${indent(body)}\n}`;
}

/**
 * Custom tag call: `_uiButton({variant: "x", content: _content(...)})`
 * -> `elements.UiButton(w, elements.UiButtonInput{Variant: "x", ...})`.
 * Object keys map to struct fields (capitalized); omitted fields keep their
 * Go zero value, which is exactly Marko's "attribute not passed".
 */
export function translateTagCall(ctx, node) {
  const entry = ctx.localToTag.get(node.callee.name);
  ctx.usedTags.add(entry);
  const qualifier = entry.sameDir ? "" : `${entry.alias}.`;
  const [argObj] = node.arguments;
  const fields = [];
  if (argObj && !(t.isObjectExpression(argObj) && argObj.properties.length === 0)) {
    if (!t.isObjectExpression(argObj)) {
      throw new UnsupportedError(
        "custom tag called with a non-literal input object -- not supported yet",
        node,
      );
    }
    for (const prop of argObj.properties) {
      if (!t.isObjectProperty(prop) || prop.computed) {
        throw new UnsupportedError(
          "spread and computed properties are not supported in a custom tag's input",
          prop,
        );
      }
      const key = t.isIdentifier(prop.key)
        ? prop.key.name
        : t.isStringLiteral(prop.key)
          ? prop.key.value
          : null;
      if (key === null) throw new UnsupportedError("unsupported tag input key", prop.key);
      const goField = goFieldName(key);
      const declaredType = entry.inputFields?.get(goField);
      let value;
      if (isContentCall(ctx, prop.value)) {
        value = translateContent(ctx, prop.value);
      } else if (calleeIs(ctx, prop.value, "attrTag")) {
        value = translateAttrTag(ctx, prop.value, entry, key, goField, declaredType);
      } else if (declaredType === "map[string]any" && t.isObjectExpression(prop.value)) {
        // `attrs={...}` -- the callee declares map[string]any, so force
        // that even when every value happens to be a string.
        value = translateObjectAsMap(ctx, prop.value).replace(
          /^map\[string\]string/,
          "map[string]any",
        );
      } else {
        value = translateExpr(ctx, prop.value);
        // JS `&&`/`||` in value position return an OPERAND, so they
        // translate to runtime.And/OrValue, which are `any`-typed. A field
        // the callee declares as `string` (e.g. `class?: string` fed by
        // `class=(cond && "active")`) needs that narrowed -- the call site
        // is the only place that knows the target type.
        if (declaredType === "string" && !isStringTyped(ctx, prop.value)) {
          value = `runtime.String(${value})`;
        }
      }
      fields.push(`${goField}: ${value},`);
    }
  }
  const structLit = `${qualifier}${entry.pascalName}Input`;
  if (fields.length === 0) {
    return `${qualifier}${entry.pascalName}(w, ${structLit}{})`;
  }
  return [
    `${qualifier}${entry.pascalName}(w, ${structLit}{`,
    indent(fields),
    `})`,
  ].join("\n");
}

/**
 * FR11, caller side. `<@head>…</@head>` on a tag compiles to
 *
 *   head: _attrTag({ content: _content_resume("id", () => {…}, scope) })
 *
 * and becomes a pointer to the callee's generated section struct:
 *
 *   Head: &layouts.PageLayoutInputHead{Content: func(w *runtime.Writer){…}}
 *
 * The POINTER is what makes the callee's `if (input.head)` test work: nil
 * is "section not passed". The struct name comes from the callee's
 * declared field type (`*PageLayoutInputHead`), never from guessing --
 * that keeps caller and callee in agreement by construction.
 */
export function translateAttrTag(ctx, node, entry, key, goField, declaredType) {
  if (!declaredType || !declaredType.startsWith("*")) {
    throw new UnsupportedError(
      `<@${key}> is passed to <${entry.pascalName}> but that template declares \`${key}\`${
        declaredType ? ` as ${declaredType}` : " nowhere"
      } -- declare it as \`${key}?: Marko.AttrTag<{ content: Marko.Body }>\` in its \`interface Input\``,
      node,
    );
  }
  const [argObj] = node.arguments;
  if (!t.isObjectExpression(argObj)) {
    throw new UnsupportedError("unsupported attr tag payload", node);
  }
  const qualifier = entry.sameDir ? "" : `${entry.alias}.`;
  // `declaredType` is `*PageLayoutInputHead` as written in the CALLEE's
  // package; qualify it for this file and drop the `*` (we take the
  // address of a composite literal instead).
  const structName = qualifier + declaredType.slice(1);
  const fields = [];
  for (const prop of argObj.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) {
      throw new UnsupportedError("unsupported property in an attr tag", prop);
    }
    const propKey = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : null;
    if (propKey !== "content") {
      throw new UnsupportedError(
        `attr tag <@${key}> carries \`${propKey}\`, but only body content is supported so far -- attr-tag attributes are not part of the ported subset yet`,
        prop,
      );
    }
    if (!isContentCall(ctx, prop.value)) {
      throw new UnsupportedError(
        `attr tag <@${key}> must carry body content`,
        prop.value,
      );
    }
    fields.push(`Content: ${translateContent(ctx, prop.value)},`);
  }
  if (fields.length === 0) return `&${structName}{}`;
  return [`&${structName}{`, indent(fields), `}`].join("\n");
}

/**
 * `_dynamic_tag(scopeId, accessor, contentExpr, {}, 0, 0, guard)` renders
 * `<${input.content}/>` -- a body passed in by the caller. In the ported
 * subset the only supported shape is a direct `input.<field>` of type
 * Marko.Body; anything else (a dynamic component reference) has no Go
 * analogue.
 */
export function translateDynamicTag(ctx, node) {
  const contentExpr = node.arguments[2];
  // Two supported shapes, both resolving to a runtime.Body reachable from
  // `input`: the template's own body (`<${input.content}/>`) and an attr
  // tag's body (`<${input.head.content}/>`, FR11). Anything else -- a
  // dynamic component reference -- has no Go analogue.
  const declared = isMemberChainFromInput(ctx, contentExpr)
    ? inferGoType(ctx, contentExpr)
    : undefined;
  if (declared === undefined) {
    throw new UnsupportedError(
      "dynamic tags are only supported for a body passed as input (e.g. `<${input.content}/>`)",
      contentExpr ?? node,
    );
  }
  if (declared !== null && declared !== "runtime.Body" && declared !== "any") {
    throw new UnsupportedError(
      `\`${sourceMemberPath(contentExpr)}\` is rendered as a body but declared as ${declared} -- declare it as Marko.Body`,
      contentExpr,
    );
  }
  const ref = translateExpr(ctx, contentExpr);
  return `if ${ref} != nil {\n\t${ref}(w)\n}`;
}

/** `input.content` / `input.head.content` -- a dotted chain rooted at input. */
export function isMemberChainFromInput(ctx, node) {
  let cur = node;
  while (
    (t.isMemberExpression(cur) || t.isOptionalMemberExpression(cur)) &&
    !cur.computed &&
    t.isIdentifier(cur.property)
  ) {
    cur = cur.object;
  }
  return t.isIdentifier(cur) && cur.name === ctx.inputParamName;
}

/** Renders a member chain back as JS source, for error messages. */
export function sourceMemberPath(node) {
  if (t.isIdentifier(node)) return node.name;
  return `${sourceMemberPath(node.object)}.${node.property.name}`;
}

// ---------------------------------------------------------------------------
// Statement translation. Lives here rather than in emit.mjs because every
// branch of it is an expression translation in statement position.
// ---------------------------------------------------------------------------

/**
 * Statement-level translator, used for the renderer body and every nested
 * block (for-of callbacks, if branches, tag bodies). Returns an array of Go
 * statement strings (possibly empty, for a dropped construct).
 */
export function translateStatement(ctx, node) {
  const { STATEMENT_INTRINSICS, RESUME_ONLY, TAG_CALL } = intrinsicTables();

  if (t.isVariableDeclaration(node)) {
    const lines = [];
    for (const decl of node.declarations) {
      if (decl.init && isResumeOnlyCall(ctx, decl.init)) continue; // dropped
      // `const $input_events__closures = new Set();` -- the compiler's
      // per-signal closure registry. It exists only so `_subscribe` can
      // wire up client-side re-renders, and every consumer of it is itself
      // RESUME_ONLY, so on a server-only fresh mount the whole set is dead.
      // Dropped for the same reason as the resume-only calls above.
      if (decl.init && t.isNewExpression(decl.init)) continue;
      // FR10: `const $global = _$global();` binds the request context.
      // Go gets it off the Writer with a COMMA-OK assertion, so a render
      // with no globals set (a bare `pages.Landing(w, input)`) yields the
      // zero value instead of panicking -- that's the documented contract
      // on runtime.Writer.SetGlobals.
      if (decl.init && calleeIs(ctx, decl.init, "$global")) {
        if (!t.isIdentifier(decl.id)) {
          throw new UnsupportedError("unexpected $global binding form", decl);
        }
        const entry = useGlobalsOn(ctx, decl);
        ctx.globalsBinding = decl.id.name;
        const qualifier = entry.sameDir ? "" : `${entry.alias}.`;
        lines.push(`${GLOBALS_VAR}, _ := w.Globals().(${qualifier}${GLOBALS_TYPE_NAME})`);
        continue;
      }
      if (!t.isIdentifier(decl.id)) {
        throw new UnsupportedError("destructuring assignment is not supported yet", node);
      }
      lines.push(`${decl.id.name} := ${translateExpr(ctx, decl.init)}`);
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
    return [translateIfStatement(ctx, node)];
  }
  if (t.isExpressionStatement(node)) {
    // The compiler sometimes chains calls with the comma operator (e.g.
    // `_html(...), _trailers(...)`) rather than separate statements --
    // translate each comma-separated expression as its own statement.
    const exprs = t.isSequenceExpression(node.expression)
      ? node.expression.expressions
      : [node.expression];
    const out = [];
    for (const expr of exprs) {
      if (isResumeOnlyCall(ctx, expr)) continue;
      if (
        t.isLogicalExpression(expr) &&
        expr.operator === "&&" &&
        isResumeOnlyCall(ctx, expr.right)
      ) {
        continue; // `(guard) && _scope(...)` -- resumability bookkeeping
      }
      const intrinsic = calleeIntrinsic(ctx, expr);
      const handler = intrinsic
        ? STATEMENT_INTRINSICS[intrinsic]
        : isTagCall(ctx, expr)
          ? TAG_CALL
          : undefined;
      if (handler) {
        const produced = handler.translate(ctx, expr);
        if (Array.isArray(produced)) out.push(...produced);
        else out.push(produced);
      } else if (intrinsic && RESUME_ONLY.has(intrinsic)) {
        // dropped
      } else {
        throw new UnsupportedError(
          `unsupported statement: expression of type ${expr.type}`,
          node,
        );
      }
    }
    return out;
  }
  throw new UnsupportedError(`unsupported statement type: ${node.type}`, node);
}

export function translateBlockStatements(ctx, stmts) {
  const out = [];
  for (const s of stmts) out.push(...translateStatement(ctx, s));
  return out;
}

/** A call to any intrinsic in the RESUME_ONLY set -- dropped wholesale. */
export function isResumeOnlyCall(ctx, node) {
  const intrinsic = calleeIntrinsic(ctx, node);
  return intrinsic !== undefined && intrinsicTables().RESUME_ONLY.has(intrinsic);
}

// ---------------------------------------------------------------------------
// Cycle-safe access to intrinsics.mjs + infer.mjs re-exports.
// ---------------------------------------------------------------------------

import * as intrinsicsModule from "./intrinsics.mjs";
import { GLOBALS_TYPE as GLOBALS_TYPE_NAME, useGlobals as useGlobalsOn } from "./infer.mjs";

/** Read the dispatch tables lazily so the import cycle stays inert at init. */
function intrinsicTables() {
  return intrinsicsModule;
}
