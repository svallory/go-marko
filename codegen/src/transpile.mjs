import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { UnsupportedError } from "./errors.mjs";
import { camelCase, capitalize, goStringLiteral } from "./names.mjs";
import { goFieldName, renderInputStruct } from "./inputstruct.mjs";

export { UnsupportedError };

// Intrinsics whose entire purpose is resumability/scope-tracking bookkeeping.
// Since marko-go never hydrates -- every page mounts fresh -- these are
// always safe to drop. This is *not* a general optimization; it depends on
// the "no resume" design in PLAN.md.
const RESUME_ONLY = new Set([
  "_scope_reason",
  "_serialize_guard",
  "_serialize_if",
  "_set_serialize_reason",
  "_scope_id",
  "_scope",
  "_scope_with_id",
  "_el_resume",
  "_sep",
  // `_script` is where Marko 6 puts a tag's client-side effect code. go-marko
  // is server-only, so it drops it; shipping page JS is FR6's problem (see
  // notes/go-marko-feature-requests.md) and the DX decision is still open.
  "_script",
  "_subscribe",
  "_resume_branch",
  "_resume",
  "_resume_locals",
  "_peek_scope_id",
  "_existing_scope",
  "_id",
  // Emitted by <html-script>. It renders the CSP nonce from `$global.cspNonce`,
  // which marko-go has no equivalent for (no $global yet), so it always
  // produces the empty string here. Dropping it is exactly what the JS
  // runtime does when no nonce is configured.
  "_attr_nonce",
]);

// Intrinsics this transpiler actively understands and translates.
// `_trailers` carries real markup (the compiler defers writing closing
// tags, e.g. `</body></html>`, past where resumability markers would go)
// -- same reasoning as `_for_of`'s parentEndTag, not resume-only.
const HANDLED = new Set([
  "_html",
  "_escape",
  "_for_of",
  "_if",
  "_template",
  "_trailers",
  // Body content. `_content` and `_content_resume` differ only in whether
  // the closure is registered for client-side resume; both wrap the same
  // renderer function, so they translate identically to a runtime.Body.
  "_content",
  "_content_resume",
  "_dynamic_tag",
  "_attrs",
  "_attr",
  "_attr_class",
  "_attr_style",
]);

/**
 * Transpiles the html-target JS produced by @marko/compiler +
 * @marko/runtime-tags into Go source calling into the `runtime` package.
 * Only the subset described in PLAN.md / notes/fr1-design.md is supported;
 * anything else throws UnsupportedError rather than emitting something wrong.
 *
 * @param {string} jsSource compiled html-target JS
 * @param {object} opts
 * @param {string} opts.goPackage    package clause for the generated file
 * @param {string} opts.templateName kebab basename, e.g. "ui-button"
 * @param {string} opts.pascalName   e.g. "UiButton"
 * @param {{name,goType}[]} [opts.inputFields] parsed from `interface Input`
 * @param {{name: string, fields: object[]}[]} [opts.nestedStructs] extra
 *        named structs generated for inline object types in `interface Input`
 *        (see inputstruct.mjs's nestedStructName). Emitted alongside the Input
 *        struct, and used by the type inferencer to type loop variables.
 * @param {(spec: string) => ({pkgName,pascalName,goImportPath,sameDir}|null)} [opts.resolveTag]
 *        maps a `.marko` import specifier (relative to this file) to the
 *        registry entry for the template it names. Required for any file
 *        that composes other tags.
 * @returns {{code: string, imports: string[]}} Go source + import paths used
 */
export function transpile(jsSource, opts) {
  const {
    goPackage,
    templateName,
    pascalName,
    inputFields = [],
    nestedStructs = [],
    resolveTag = () => null,
  } = opts;

  const ast = parse(jsSource, { sourceType: "module" });
  const constPrefix = camelCase(templateName);
  const structName = `${pascalName}Input`;
  const inputFieldTypes = new Map(inputFields.map((f) => [f.name, f.goType]));

  // ---- Minimal Go type inference -------------------------------------
  //
  // The compiled JS carries no types, but the template's own
  // `export interface Input` does, and inputstruct.mjs has already mapped it
  // to Go types -- including named structs for inline object types. That is
  // enough to type the one place where it matters: a for-of loop's element.
  //
  // `input.events` is known to be `[]CounterInputEvents`, so the loop can be
  // emitted as `runtime.ForOfIndexed(input.events, func(event CounterInputEvents, i int))`
  // -- which makes `event.Label` resolve to a real struct field instead of
  // needing a runtime type assertion. The loop variable's type is then in
  // scope for nested loops (`for|tag| of=event.tags`), so inference composes.
  //
  // Everything here is best-effort: an unknown type is `null`, and every
  // consumer has a working `any`-shaped fallback (ForOfAny et al). We never
  // guess -- a wrong Go type would be a compile error at best and wrong
  // output at worst.

  /** Go struct name -> Map(goFieldName -> goType), for nested Input structs. */
  const structFieldTypes = new Map(
    nestedStructs.map((s) => [s.name, new Map(s.fields.map((f) => [f.name, f.goType]))]),
  );

  /** Lexical scope of locally-typed identifiers (loop vars), innermost last. */
  const typeScopes = [new Map()];
  const lookupLocalType = (name) => {
    for (let i = typeScopes.length - 1; i >= 0; i--) {
      if (typeScopes[i].has(name)) return typeScopes[i].get(name);
    }
    return null;
  };

  /**
   * Best-effort Go type of a JS expression, or null when unknown.
   * Deliberately covers only what the fixture space needs: the input
   * identifier, member access into Input/nested structs, and loop variables.
   */
  function inferGoType(node) {
    if (t.isIdentifier(node)) {
      if (node.name === inputParamName) return structName;
      return lookupLocalType(node.name);
    }
    if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
      if (node.property.name === "length") return "int"; // len(...)
      const objType = inferGoType(node.object);
      if (!objType) return null;
      const fieldName = capitalize(node.property.name);
      if (objType === structName) return inputFieldTypes.get(fieldName) ?? null;
      return structFieldTypes.get(objType)?.get(fieldName) ?? null;
    }
    return null;
  }

  /** `[]T` -> `T`; anything else (including `[]any`) -> null. */
  function sliceElemType(goType) {
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
  function isBooleanShaped(node) {
    if (t.isBooleanLiteral(node)) return true;
    if (t.isUnaryExpression(node) && node.operator === "!") return true;
    if (t.isBinaryExpression(node)) {
      return ["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"].includes(
        node.operator,
      );
    }
    if (t.isLogicalExpression(node) && node.operator !== "??") {
      return isBooleanShaped(node.left) && isBooleanShaped(node.right);
    }
    if (t.isParenthesizedExpression?.(node)) return isBooleanShaped(node.expression);
    return inferGoType(node) === "bool";
  }

  // 1. Imports. Two flavours appear in compiled output:
  //    a) `import {_html, ...} from "@marko/runtime-tags/html"` -- intrinsics.
  //    b) `import _uiButton from "../elements/ui-button.marko"` -- a custom
  //       tag. Marko names the binding after the kebab file name in camel
  //       case with a leading underscore; we key off the specifier, not the
  //       binding name, and resolve it through the project registry.
  const localToIntrinsic = new Map();
  const localToTag = new Map();
  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node)) continue;
    const src = node.source.value;
    if (/runtime-tags\/(debug\/)?html$/.test(src)) {
      for (const spec of node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          localToIntrinsic.set(spec.local.name, spec.imported.name);
        }
      }
      continue;
    }
    if (src.endsWith(".marko")) {
      const entry = resolveTag(src);
      if (!entry) {
        throw new UnsupportedError(
          `custom tag import "${src}" could not be resolved to a template in the project -- is it inside the generate root?`,
          node,
        );
      }
      const spec = node.specifiers.find((s) => t.isImportDefaultSpecifier(s));
      if (!spec) {
        throw new UnsupportedError(`unexpected import form for "${src}"`, node);
      }
      localToTag.set(spec.local.name, entry);
      continue;
    }
    throw new UnsupportedError(
      `unsupported import in compiled output: "${src}"`,
      node,
    );
  }
  if (localToIntrinsic.size === 0) {
    throw new UnsupportedError(
      "no import from @marko/runtime-tags/html found -- is this html-target output?",
    );
  }
  for (const [, intrinsic] of localToIntrinsic) {
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
  const isTagCall = (node) =>
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    localToTag.has(node.callee.name);
  const isContentCall = (node) =>
    calleeIs(node, "_content") || calleeIs(node, "_content_resume");

  // Tracks which cross-package imports this file actually needs, so the
  // import block only lists what's used.
  const usedTags = new Set();

  // 2. Module-level `static const` declarations. In compiled JS these are
  //    plain top-level `const`s hoisted above the template. They become
  //    package-level Go vars; every generated file in a directory shares one
  //    Go package, so names are prefixed with the camelCase template name
  //    (`uiButtonVariants`) to avoid collisions between sibling templates.
  const moduleConsts = new Map(); // js name -> go name
  const moduleConstDecls = [];
  for (const node of ast.program.body) {
    if (!t.isVariableDeclaration(node)) continue;
    for (const decl of node.declarations) {
      if (!t.isIdentifier(decl.id)) {
        throw new UnsupportedError(
          "destructured module-level declarations are not supported yet",
          decl,
        );
      }
      moduleConsts.set(decl.id.name, constPrefix + capitalize(decl.id.name));
    }
  }

  // 3. Find `export default _template(id, renderer, page?)`.
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
  if (
    renderer.params.length > 1 ||
    (renderer.params[0] && !t.isIdentifier(renderer.params[0]))
  ) {
    throw new UnsupportedError(
      "destructured or multiple input params are not supported yet -- use a single `input` identifier",
      renderer,
    );
  }
  const inputParamName = renderer.params[0]?.name ?? "input";
  if (!t.isBlockStatement(renderer.body)) {
    throw new UnsupportedError(
      "expected a block-bodied renderer function",
      renderer,
    );
  }

  // 4. Expression translator: JS -> Go, for the narrow set of shapes that
  //    show up in compiled Marko output.
  function translateExpr(node) {
    if (t.isIdentifier(node)) {
      if (node.name === inputParamName) return "input";
      if (node.name === "undefined") return "nil";
      const modConst = moduleConsts.get(node.name);
      return modConst ?? node.name;
    }
    if (t.isMemberExpression(node)) {
      if (node.computed) {
        // `variants[key]` -- a Go map/slice index. Identical syntax.
        return `${translateExpr(node.object)}[${translateExpr(node.property)}]`;
      }
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
    if (
      t.isArrayExpression(node) &&
      node.elements.every((e) => e && !t.isSpreadElement(e))
    ) {
      // Element type is unknown from JS alone -- see the []any contract
      // for Input slice fields in PLAN.md. runtime.AttrClass accepts
      // []any, which is what makes `class=[a, b, c]` work.
      return `[]any{${node.elements.map(translateExpr).join(", ")}}`;
    }
    if (t.isObjectExpression(node)) {
      return translateObjectAsMap(node);
    }
    if (t.isBinaryExpression(node)) {
      const op =
        node.operator === "===" ? "==" : node.operator === "!==" ? "!=" : node.operator;
      return `${translateExpr(node.left)} ${op} ${translateExpr(node.right)}`;
    }
    if (t.isLogicalExpression(node)) {
      if (node.operator === "??") {
        // Go has no nullish coalescing and no "unset" for a struct field.
        // runtime.Or substitutes the zero value as the "absent" test; the
        // divergence from JS (where `""` and `0` are NOT nullish) is
        // documented on runtime.Or itself.
        return `runtime.Or(${translateExpr(node.left)}, ${translateExpr(node.right)})`;
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
      if (isBooleanShaped(node.left) && isBooleanShaped(node.right)) {
        return `${translateExpr(node.left)} ${node.operator} ${translateExpr(node.right)}`;
      }
      const fn = node.operator === "&&" ? "runtime.And" : "runtime.OrValue";
      return `${fn}(${translateExpr(node.left)}, ${translateExpr(node.right)})`;
    }
    if (t.isUnaryExpression(node) && node.operator === "!") {
      return `!${translateExpr(node.argument)}`;
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
  function translateObjectAsMap(node) {
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
      entries.push(`${goStringLiteral(key)}: ${translateExpr(prop.value)}`);
    }
    const mapType = allStrings ? "map[string]string" : "map[string]any";
    if (entries.length === 0) return "map[string]any{}";
    return `${mapType}{\n${entries.map((e) => "\t" + e + ",").join("\n")}\n}`;
  }

  // 5. `_html(arg)` -> one or more `w.HTML(...)` statements. `arg` is
  //    either a plain string (static markup) or a template literal mixing
  //    static text with dynamic interpolations: `_escape(...)` for text,
  //    `_attrs`/`_attr*` for attribute groups, and resume-only markers
  //    (`_el_resume`, `_sep`, `_attr_nonce`), which are dropped.
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
        } else if (calleeIs(expr, "_attrs")) {
          out.push(`w.HTML(${translateAttrs(expr)})`);
        } else if (calleeIs(expr, "_attr_class")) {
          out.push(`w.HTML(runtime.AttrClass(${translateExpr(expr.arguments[0])}))`);
        } else if (calleeIs(expr, "_attr_style")) {
          out.push(`w.HTML(runtime.AttrStyle(${translateExpr(expr.arguments[0])}))`);
        } else if (calleeIs(expr, "_attr")) {
          // _attr(name, value) -> ` name="escaped"`, or "" when falsy.
          const [nameArg, valArg] = expr.arguments;
          out.push(
            `w.HTML(runtime.Attr(${translateExpr(nameArg)}, ${translateExpr(valArg)}))`,
          );
        } else if (isResumeOnlyCall(expr)) {
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
  function translateAttrs(node) {
    const [objArg] = node.arguments;
    if (!t.isObjectExpression(objArg)) {
      // A bare expression (e.g. `_attrs(input.attrs, ...)`) is still a
      // valid single spread item.
      return `runtime.Attrs(${translateExpr(objArg)})`;
    }
    const items = [];
    for (const prop of objArg.properties) {
      if (t.isSpreadElement(prop)) {
        // `...input.attrs` -- a map[string]any spread; runtime.Attrs
        // expands it with sorted keys for deterministic output.
        items.push(translateExpr(prop.argument));
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
        `runtime.A{Name: ${goStringLiteral(key)}, Value: ${translateExpr(prop.value)}}`,
      );
    }
    return `runtime.Attrs(${items.join(", ")})`;
  }

  // 6. `_for_of(items, cb, by, scopeId, accessor, sg1, sg2, sg3,
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
    const elemType = sliceElemType(inferGoType(itemsArg));
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
    typeScopes.push(
      new Map([
        [itemName, goItemType],
        ...(indexName ? [[indexName, "int"]] : []),
      ]),
    );
    let body;
    try {
      body = translateBlockStatements(cb.body.body);
    } finally {
      typeScopes.pop();
    }

    const params = indexName
      ? `${itemName} ${goItemType}, ${indexName} int`
      : `${itemName} ${goItemType}`;
    const out = [
      `${fnName}(${translateExpr(itemsArg)}, func(${params}) {`,
      indent(body),
      `})`,
    ];
    if (t.isStringLiteral(parentEndTagArg) && parentEndTagArg.value !== "") {
      out.push(`w.HTML(${goStringLiteral(parentEndTagArg.value)})`);
    }
    return out.join("\n");
  }

  // 7. `_if(cb, ...)` unwraps to whatever native `if` statement is inside
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

  // 8. `_content(id, renderer, parentScopeId)` / `_content_resume(...)`
  //    -> a runtime.Body closure. This is a <tag> body: the caller decides
  //    where (and whether) it renders. The `w` in scope is captured by the
  //    closure parameter so nested bodies never see a stale writer.
  function translateContent(node) {
    const [, renderer] = node.arguments;
    if (
      !(t.isArrowFunctionExpression(renderer) || t.isFunctionExpression(renderer))
    ) {
      throw new UnsupportedError("_content body is not a function", node);
    }
    if (!t.isBlockStatement(renderer.body)) {
      throw new UnsupportedError("expected a block-bodied _content renderer", renderer);
    }
    const body = translateBlockStatements(renderer.body.body);
    return `func(w *runtime.Writer) {\n${indent(body)}\n}`;
  }

  // 9. Custom tag call: `_uiButton({variant: "x", content: _content(...)})`
  //    -> `elements.UiButton(w, elements.UiButtonInput{Variant: "x", ...})`.
  //    Object keys map to struct fields (capitalized); omitted fields keep
  //    their Go zero value, which is exactly Marko's "attribute not passed".
  function translateTagCall(node) {
    const entry = localToTag.get(node.callee.name);
    usedTags.add(entry);
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
        if (isContentCall(prop.value)) {
          value = translateContent(prop.value);
        } else if (declaredType === "map[string]any" && t.isObjectExpression(prop.value)) {
          // `attrs={...}` -- the callee declares map[string]any, so force
          // that even when every value happens to be a string.
          value = translateObjectAsMap(prop.value).replace(
            /^map\[string\]string/,
            "map[string]any",
          );
        } else {
          value = translateExpr(prop.value);
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

  // 10. `_dynamic_tag(scopeId, accessor, contentExpr, {}, 0, 0, guard)`
  //     renders `<${input.content}/>` -- a body passed in by the caller.
  //     In the ported subset the only supported shape is a direct
  //     `input.<field>` of type Marko.Body; anything else (a dynamic
  //     component reference) has no Go analogue.
  function translateDynamicTag(node) {
    const contentExpr = node.arguments[2];
    if (
      !t.isMemberExpression(contentExpr) ||
      contentExpr.computed ||
      !t.isIdentifier(contentExpr.object) ||
      contentExpr.object.name !== inputParamName
    ) {
      throw new UnsupportedError(
        "dynamic tags are only supported for a body passed as input (e.g. `<${input.content}/>`)",
        contentExpr ?? node,
      );
    }
    const field = capitalize(contentExpr.property.name);
    const declared = inputFieldTypes.get(field);
    if (declared && declared !== "runtime.Body" && declared !== "any") {
      throw new UnsupportedError(
        `\`input.${contentExpr.property.name}\` is rendered as a body but declared as ${declared} -- declare it as Marko.Body`,
        contentExpr,
      );
    }
    return `if input.${field} != nil {\n\tinput.${field}(w)\n}`;
  }

  // 11. Statement-level translator, used for the renderer body and every
  //     nested block (for-of callbacks, if branches, tag bodies).
  function translateStatement(node) {
    if (t.isVariableDeclaration(node)) {
      const lines = [];
      for (const decl of node.declarations) {
        if (decl.init && isResumeOnlyCall(decl.init)) continue; // dropped
        // `const $input_events__closures = new Set();` -- the compiler's
        // per-signal closure registry. It exists only so `_subscribe` can
        // wire up client-side re-renders, and every consumer of it is itself
        // RESUME_ONLY, so on a server-only fresh mount the whole set is dead.
        // Dropped for the same reason as the resume-only calls above.
        if (decl.init && t.isNewExpression(decl.init)) continue;
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
      // The compiler sometimes chains calls with the comma operator (e.g.
      // `_html(...), _trailers(...)`) rather than separate statements --
      // translate each comma-separated expression as its own statement.
      const exprs = t.isSequenceExpression(node.expression)
        ? node.expression.expressions
        : [node.expression];
      const out = [];
      for (const expr of exprs) {
        if (isResumeOnlyCall(expr)) continue;
        if (
          t.isLogicalExpression(expr) &&
          expr.operator === "&&" &&
          isResumeOnlyCall(expr.right)
        ) {
          continue; // `(guard) && _scope(...)` -- resumability bookkeeping
        }
        if (calleeIs(expr, "_html") || calleeIs(expr, "_trailers")) {
          out.push(...translateHtmlCall(expr));
        } else if (calleeIs(expr, "_for_of")) {
          out.push(translateForOf(expr));
        } else if (calleeIs(expr, "_if")) {
          out.push(translateIfWrapper(expr));
        } else if (calleeIs(expr, "_dynamic_tag")) {
          out.push(translateDynamicTag(expr));
        } else if (isTagCall(expr)) {
          out.push(translateTagCall(expr));
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

  function translateBlockStatements(stmts) {
    const out = [];
    for (const s of stmts) out.push(...translateStatement(s));
    return out;
  }

  function indent(lines) {
    return lines
      .map((l) => l.split("\n").map((ln) => (ln === "" ? "" : "\t" + ln)).join("\n"))
      .join("\n");
  }

  // Module consts are translated last so `translateExpr` (and therefore
  // moduleConsts / usedTags) is fully wired up first.
  for (const node of ast.program.body) {
    if (!t.isVariableDeclaration(node)) continue;
    for (const decl of node.declarations) {
      moduleConstDecls.push(
        `var ${moduleConsts.get(decl.id.name)} = ${translateExpr(decl.init)}`,
      );
    }
  }

  const bodyGo = translateBlockStatements(renderer.body.body);

  // 12. Assemble. Import block lists the runtime plus one aliased import
  //     per cross-directory tag dependency actually used.
  const importLines = ['"github.com/svallory/go-marko/runtime"'];
  const seenPaths = new Set();
  for (const entry of [...usedTags].sort((a, b) =>
    a.goImportPath.localeCompare(b.goImportPath),
  )) {
    if (entry.sameDir || seenPaths.has(entry.goImportPath)) continue;
    seenPaths.add(entry.goImportPath);
    const needsAlias = entry.alias !== entry.pkgName;
    importLines.push(
      needsAlias
        ? `${entry.alias} "${entry.goImportPath}"`
        : `"${entry.goImportPath}"`,
    );
  }
  const importBlock =
    importLines.length === 1
      ? `import ${importLines[0]}`
      : `import (\n${importLines.map((l) => "\t" + l).join("\n")}\n)`;

  const parts = [
    "// Code generated by marko-go. DO NOT EDIT.",
    `package ${goPackage}`,
    "",
    importBlock,
    "",
  ];
  if (moduleConstDecls.length > 0) {
    // `static const` in Marko is module-scoped and evaluated once. Go
    // package vars are the closest equivalent (a Go `const` can't hold a
    // composite literal).
    parts.push(moduleConstDecls.join("\n\n"), "");
  }
  parts.push(renderInputStruct(structName, inputFields), "");
  // Structs generated for inline object types in `interface Input`, named
  // <OuterStruct><Field> (CounterInput.events -> CounterInputEvents). Emitted
  // after the Input struct that references them, in declaration order.
  for (const s of nestedStructs) {
    parts.push(renderInputStruct(s.name, s.fields), "");
  }
  parts.push(
    `// ${pascalName} renders the ${templateName}.marko template into w.`,
    `func ${pascalName}(w *runtime.Writer, input ${structName}) {`,
    indent(bodyGo),
    "}",
    "",
  );

  return { code: alignKeyValueRuns(parts.join("\n")), imports: [...seenPaths] };
}

/**
 * gofmt aligns the values of consecutive single-line `Key: value,` entries
 * inside a composite literal (and `Name Type` inside a struct type). We emit
 * gofmt-clean Go directly rather than shelling out to the Go toolchain, so
 * this reproduces that one rule: within each maximal run of same-indent
 * lines matching `key: value,` -- broken by any other line, including a
 * multi-line value's opening brace -- pad the key column to the widest key.
 *
 * gofmt also breaks a run when a line is "too far" from its neighbours, but
 * that threshold only applies to comment alignment, not composite literals.
 */
export function alignKeyValueRuns(code) {
  const lines = code.split("\n");
  // Key is a bare Go identifier or a simple quoted string; the entry must
  // end in a comma. That's narrow enough that a `w.HTML("http://...")` line
  // (which also contains a colon) can never be mistaken for a literal entry.
  const KV = /^(\t*)([A-Za-z_][A-Za-z0-9_]*|"[^"\\]*"): (\S.*?)(,)$/;
  let i = 0;
  while (i < lines.length) {
    const m = KV.exec(lines[i]);
    // A value ending in `{` opens a multi-line literal; gofmt treats such a
    // line as breaking the run rather than joining it.
    if (!m || m[3].endsWith("{")) {
      i++;
      continue;
    }
    const indentStr = m[1];
    const run = [];
    let j = i;
    for (; j < lines.length; j++) {
      const mm = KV.exec(lines[j]);
      if (!mm || mm[1] !== indentStr || mm[3].endsWith("{")) break;
      run.push(mm);
    }
    if (run.length > 1) {
      const width = Math.max(...run.map((r) => r[2].length));
      run.forEach((r, k) => {
        lines[i + k] = `${r[1]}${r[2]}:${" ".repeat(width - r[2].length + 1)}${r[3]}${r[4]}`;
      });
    }
    i = j > i ? j : i + 1;
  }
  return lines.join("\n");
}
