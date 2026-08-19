/**
 * The transpile context (`ctx`) -- the ONE piece of mutable state threaded
 * explicitly through every codegen module.
 *
 * Before this existed, transpile.mjs was a single 1,100-line closure: intrinsic
 * sets, type inference, expression translation, statement dispatch and file
 * assembly all captured the same lexical variables, so nothing could be tested,
 * replaced, or extended in isolation. `ctx` replaces that capture. Every
 * function in expr.mjs / infer.mjs / emit.mjs / intrinsics.mjs takes `ctx` as
 * its first parameter and reaches ONLY through it.
 *
 * ## Shape
 *
 * ### Per-file identity (immutable for the run)
 *   goPackage      string   package clause of the generated file
 *   templateName   string   kebab basename, e.g. "ui-button"
 *   pascalName     string   e.g. "UiButton"
 *   structName     string   `${pascalName}Input`
 *   constPrefix    string   camelCase(templateName); prefixes module consts
 *
 * ### Type information (read-mostly; see infer.mjs)
 *   inputFields       {name,goType}[]         parsed `interface Input`
 *   inputFieldTypes   Map<goField, goType>    same, indexed
 *   nestedStructs     {name,fields}[]         structs for inline object types
 *   structFieldTypes  Map<structName, Map<goField, goType>>
 *   typeScopes        Map<jsName, goType>[]   lexical stack, innermost last;
 *                                             pushed/popped by loop bodies
 *   inputParamName    string   the renderer's parameter name (usually "input")
 *
 * ### Bindings resolved from the compiled module (see transpile.mjs's scan)
 *   localToIntrinsic  Map<localName, intrinsicName>
 *   localToTag        Map<localName, registryEntry>
 *   moduleConsts      Map<jsName, goName>   module-level `static const`s
 *
 * ### Project hooks (injected by project.mjs)
 *   resolveTag()      specifier -> registry entry | null
 *   resolveGlobals()  () -> globals entry | null   (consulted lazily)
 *
 * ### Accumulated output / usage (mutated during translation)
 *   usedTags        Set<registryEntry>  cross-package imports actually needed
 *   globalsBinding  string|null   local name bound to `_$global()`, once seen
 *   globalsEntry    object|null   resolved Globals type, memoized on first use
 *
 * ### Resumability (FR12 wave 1). See resume.mjs.
 *
 * The design this section originally RESERVED assumed the payload was built at
 * transpile time -- a `scopeIds` allocator and a `serialized` accumulator
 * living on `ctx`. That turned out to be the wrong shape, and the reason is
 * worth keeping: scope ids and serialized values are per-RENDER runtime
 * quantities. `_scope_id()` post-increments a counter as the render walks the
 * tree, so a body closure's ids depend on WHERE THE CALLEE RENDERS IT, which no
 * amount of transpile-time analysis can know. The accumulators therefore live
 * on the Go `runtime.Writer` (AllocScopeID / AddScope / AddScript / Marker),
 * and codegen's job is only to emit the calls in the right ORDER.
 *
 *   resume  {
 *     used         boolean               did this template emit any resume Go?
 *     isPage       boolean               `_template(id, fn, 1)` -- a page root,
 *                                        and therefore the one place that
 *                                        flushes the payload.
 *     scopeVars    Map<jsName, goName>   `$scope0_id` -> `scope0_id`
 *     guardConsts  Map<jsName, number>   `$sg__input_href` -> 0
 *     registryIds  Set<string>           `_script` ids this template references
 *   }
 *
 * `scopeVars` and `guardConsts` are per-BODY in the JS but flat here: the
 * compiler's names are unique within a module (`$scope0_id`, `$scope1_id`, ...),
 * so one table cannot collide, and a flat table means a nested body closure can
 * still resolve a scope id bound by its enclosing template.
 */

import { camelCase } from "./names.mjs";

/**
 * Build a fresh context for one template file.
 *
 * @param {object} opts the same options `transpile()` accepts
 * @returns {object} ctx
 */
export function createContext(opts) {
  const {
    goPackage,
    templateName,
    pascalName,
    inputFields = [],
    nestedStructs = [],
    resolveTag = () => null,
    resolveGlobals = () => null,
  } = opts;

  return {
    // --- per-file identity ------------------------------------------------
    goPackage,
    templateName,
    pascalName,
    structName: `${pascalName}Input`,
    constPrefix: camelCase(templateName),

    // --- type information -------------------------------------------------
    inputFields,
    inputFieldTypes: new Map(inputFields.map((f) => [f.name, f.goType])),
    /**
     * Go field names of the input fields declared `field?:`. Go has no "unset"
     * for a scalar struct field -- the zero value stands in for absent (see
     * inputstruct.mjs) -- but the WIRE distinguishes them: JS receives
     * `undefined` for an omitted attribute and Marko drops it from both the
     * markup and the resume payload, whereas `""` renders as a bare attribute
     * and serializes as `""`. This set is what lets an optional scalar read be
     * translated back into `undefined`. See expr.mjs's absentIfZero.
     */
    optionalInputFields: new Set(
      inputFields.filter((f) => f.optional).map((f) => f.name),
    ),
    nestedStructs,
    /** Go struct name -> Map(goFieldName -> goType), for nested Input structs. */
    structFieldTypes: new Map(
      nestedStructs.map((s) => [s.name, new Map(s.fields.map((f) => [f.name, f.goType]))]),
    ),
    /** Lexical scope of locally-typed identifiers (loop vars), innermost last. */
    typeScopes: [new Map()],
    inputParamName: "input",

    // --- bindings from the compiled module --------------------------------
    localToIntrinsic: new Map(),
    localToTag: new Map(),
    moduleConsts: new Map(),

    // --- project hooks ----------------------------------------------------
    resolveTag,
    resolveGlobals,

    // --- accumulated during translation -----------------------------------
    usedTags: new Set(),
    globalsBinding: null,
    globalsEntry: null,

    // --- resumability (FR12 wave 1). See the header comment + resume.mjs ---
    resume: {
      used: false,
      isPage: false,
      scopeVars: new Map(),
      guardConsts: new Map(),
      registryIds: new Set(),
    },
  };
}

/**
 * Does this template's generated Go need to flush a resume payload?
 *
 * Only a PAGE root does. A called template contributes markers, scopes and
 * script entries to the SAME Writer, and the page root flushes them all once
 * at the end; a callee that flushed would emit the payload mid-document, before
 * its own siblings had contributed. `isPage` comes from the compiler's own
 * signal -- the third argument to `_template(id, renderer, page)` -- rather
 * than from a heuristic about `<html>` roots.
 */
export function needsResumeFlush(ctx) {
  return ctx.resume.isPage;
}
