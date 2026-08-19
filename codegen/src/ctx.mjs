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
 * ### RESERVED -- resumability (FR12). Declared, not implemented.
 *
 * These three fields are the extension point the whole split exists for. See
 * notes/fr12-resume-findings.md §4/§5/§7. They are initialized to their empty
 * value so a translator can start using one without touching this file's
 * shape, and so `ctx` never gains a field by accident mid-run.
 *
 *   scopeIds  {next: number, alloc(): number}
 *       Per-render scope-id allocator. The JS runtime's ids are **1-based**
 *       (findings §2: an off-by-one here was one of two bugs the byte-oracle
 *       caught), so `next` starts at 1 and `alloc()` post-increments.
 *       Consumed by `_scope_id`, `_scope`, `_el_resume`, `_scope_with_id`.
 *
 *   serialized  {values: any[], byRef: Map<object, number>, add(v): number}
 *       Accumulator for the resume payload. Marko's serializer is
 *       REFERENCE-IDENTITY deduped -- the same object appearing twice must
 *       serialize once and be back-referenced -- so `byRef` is keyed by object
 *       identity (a Map, never a string key) and `add` returns the existing
 *       index on a repeat. Consumed by `_scope`.
 *
 *   channels  {html: null, resume: string[]}
 *       Secondary output channels beside the `w.HTML` stream. `html` is a
 *       placeholder for symmetry (the primary stream is emitted inline as
 *       `w.HTML(...)` statements today and stays that way). `resume` collects
 *       the statements that must be written AFTER all HTML, in the JS
 *       runtime's fixed order: **scopes first, then scripts** (findings §2 --
 *       the other bug the byte-oracle caught). `_script` appends here; the
 *       flush point is the end of the renderer body in emit.mjs.
 *
 * Nothing reads these today. `emit.mjs` asserts they are empty before
 * assembling a file, so the first translator that starts filling one and
 * forgets to flush it fails loudly instead of silently dropping the payload.
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

    // --- RESERVED: resumability (FR12). See the header comment. -----------
    scopeIds: {
      next: 1, // 1-based; see findings §2
      alloc() {
        return this.next++;
      },
    },
    serialized: {
      values: [],
      /** Reference identity, NOT structural -- Marko dedupes by identity. */
      byRef: new Map(),
      add(value) {
        const seen = this.byRef.get(value);
        if (seen !== undefined) return seen;
        const index = this.values.length;
        this.values.push(value);
        if (value !== null && typeof value === "object") this.byRef.set(value, index);
        return index;
      },
    },
    channels: {
      html: null, // the primary w.HTML stream is emitted inline
      resume: [], // ordered scopes-then-scripts, flushed after all HTML
    },
  };
}

/**
 * True when nothing has been written to a reserved resume channel. emit.mjs
 * checks this before assembling a file: once a translator starts producing
 * resume output, it must also arrange for it to be flushed, and a silent drop
 * would be invisible in the generated Go.
 */
export function resumeChannelsEmpty(ctx) {
  return ctx.channels.resume.length === 0 && ctx.serialized.values.length === 0;
}
