/**
 * Orchestrator: compiled html-target JS in, Go source out.
 *
 * The actual work is split across four modules, all of which thread the same
 * explicit `ctx` object (see ctx.mjs for its documented shape) rather than
 * capturing a closure:
 *
 *   ctx.mjs         the context object + its reserved FR12 extension points
 *   intrinsics.mjs  which intrinsics are handled/dropped + dispatch tables
 *   infer.mjs       Go type inference from `interface Input`
 *   expr.mjs        JS expression/statement -> Go translation
 *   emit.mjs        Go source assembly, indenting, gofmt alignment, imports
 *
 * This file does only the module-shape work: scan imports, find the
 * `export default _template(...)`, hoist module consts, translate the renderer
 * body, hand the pieces to emit.
 */

import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { UnsupportedError } from "./errors.mjs";
import { capitalize } from "./names.mjs";
import { createContext } from "./ctx.mjs";
import { assertAllIntrinsicsKnown } from "./intrinsics.mjs";
import { calleeIs, translateBlockStatements, translateExpr } from "./expr.mjs";
import { alignKeyValueRuns, assembleFile } from "./emit.mjs";

export { UnsupportedError };
// Re-exported for tests and for anything that wants the gofmt emulation
// standalone; the implementation lives in emit.mjs.
export { alignKeyValueRuns };

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
 * @param {() => ({pkgName,goImportPath,fieldTypes,sameDir,alias}|null)} [opts.resolveGlobals]
 *        the project's generated Globals type (FR10), or null when the
 *        project declares no `Marko.Global`. Only consulted when the template
 *        actually reads `$global`.
 * @returns {{code: string, imports: string[]}} Go source + import paths used
 */
export function transpile(jsSource, opts) {
  const ctx = createContext(opts);
  const ast = parse(jsSource, { sourceType: "module" });

  scanImports(ctx, ast);
  hoistModuleConstNames(ctx, ast);
  const renderer = findRenderer(ctx, ast);

  // Module consts are translated after the renderer is located but before the
  // body, so `translateExpr` (and therefore moduleConsts / usedTags) is fully
  // wired up first.
  const moduleConstDecls = [];
  for (const node of ast.program.body) {
    if (!t.isVariableDeclaration(node)) continue;
    for (const decl of node.declarations) {
      moduleConstDecls.push(
        `var ${ctx.moduleConsts.get(decl.id.name)} = ${translateExpr(ctx, decl.init)}`,
      );
    }
  }

  const bodyGo = translateBlockStatements(ctx, renderer.body.body);

  return assembleFile(ctx, { moduleConstDecls, bodyGo });
}

/**
 * Scan the module's imports into ctx's binding tables. Two flavours appear in
 * compiled output:
 *
 *   a) `import {_html, ...} from "@marko/runtime-tags/html"` -- intrinsics.
 *   b) `import _uiButton from "../elements/ui-button.marko"` -- a custom tag.
 *      Marko names the binding after the kebab file name in camel case with a
 *      leading underscore; we key off the specifier, not the binding name, and
 *      resolve it through the project registry.
 */
function scanImports(ctx, ast) {
  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node)) continue;
    const src = node.source.value;
    if (/runtime-tags\/(debug\/)?html$/.test(src)) {
      for (const spec of node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          ctx.localToIntrinsic.set(spec.local.name, spec.imported.name);
        }
      }
      continue;
    }
    if (src.endsWith(".marko")) {
      const entry = ctx.resolveTag(src);
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
      ctx.localToTag.set(spec.local.name, entry);
      continue;
    }
    throw new UnsupportedError(
      `unsupported import in compiled output: "${src}"`,
      node,
    );
  }
  if (ctx.localToIntrinsic.size === 0) {
    throw new UnsupportedError(
      "no import from @marko/runtime-tags/html found -- is this html-target output?",
    );
  }
  assertAllIntrinsicsKnown(ctx.localToIntrinsic);
}

/**
 * Module-level `static const` declarations. In compiled JS these are plain
 * top-level `const`s hoisted above the template. They become package-level Go
 * vars; every generated file in a directory shares one Go package, so names
 * are prefixed with the camelCase template name (`uiButtonVariants`) to avoid
 * collisions between sibling templates.
 *
 * Only the NAMES are registered here -- the initializers are translated later,
 * once every binding table is populated.
 */
function hoistModuleConstNames(ctx, ast) {
  for (const node of ast.program.body) {
    if (!t.isVariableDeclaration(node)) continue;
    for (const decl of node.declarations) {
      if (!t.isIdentifier(decl.id)) {
        throw new UnsupportedError(
          "destructured module-level declarations are not supported yet",
          decl,
        );
      }
      ctx.moduleConsts.set(decl.id.name, ctx.constPrefix + capitalize(decl.id.name));
    }
  }
}

/**
 * Find `export default _template(id, renderer, page?)` and validate the
 * renderer's shape. Records the renderer's input parameter name on ctx.
 */
function findRenderer(ctx, ast) {
  const exportDefault = ast.program.body.find((n) => t.isExportDefaultDeclaration(n));
  if (!exportDefault || !calleeIs(ctx, exportDefault.declaration, "_template")) {
    throw new UnsupportedError(
      "expected `export default _template(...)` -- unrecognized module shape",
      exportDefault,
    );
  }
  const [, renderer] = exportDefault.declaration.arguments;
  if (!(t.isArrowFunctionExpression(renderer) || t.isFunctionExpression(renderer))) {
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
  ctx.inputParamName = renderer.params[0]?.name ?? "input";
  if (!t.isBlockStatement(renderer.body)) {
    throw new UnsupportedError(
      "expected a block-bodied renderer function",
      renderer,
    );
  }
  return renderer;
}
