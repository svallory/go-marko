/**
 * Client-bundle pipeline (FR12 wave 1, Phase C -- the browser half).
 *
 * The Go server emits Marko's resume payload; this produces the JavaScript
 * that consumes it. One bundle per PAGE that actually has client code.
 *
 * ## What a Marko client bundle is
 *
 * Almost nothing, which is the point. A stock Marko app's browser entry does
 * exactly two things:
 *
 *   1. import the DOM-target compile of the page template, whose module-level
 *      `_script("<registryId>", setupFn)` calls REGISTER each setup closure
 *      under the id the server put in the payload;
 *   2. call `init()` from `@marko/runtime-tags/dom`, which walks the markers
 *      the server wrote, materializes the scopes from `M._.r`, and runs the
 *      registered closures against them.
 *
 * `buildEntryModule` writes that as a two-line virtual module and Bun bundles
 * it. Everything that makes hydration work is in the stock runtime and the
 * stock compiler output; go-marko contributes no browser code of its own. That
 * was the whole thesis of the FR12 spike (`scratch/fr12-resume-spike/`), which
 * proved a hand-written Go server could drive the UNMODIFIED browser build.
 *
 * ## Registry-id consistency is the load-bearing invariant
 *
 * The ids that tie the two halves together are content hashes that include the
 * template's ABSOLUTE FILE PATH (wire contract sec 15.1: identical bytes at
 * three different paths produced three different ids). If the html compile and
 * the dom compile ever see different paths, the payload references ids nothing
 * registered: the page renders correctly, ships a bundle, throws no error, and
 * is simply dead to every click. That is the worst failure mode available
 * here, so it is not left to convention -- `assertRegistryIdsAgree` extracts
 * the ids from both compiles and fails generation loudly on any mismatch.
 *
 * ## Emptiness
 *
 * A page with no reactivity still compiles to a valid dom module (template
 * strings, walk codes, a `$setup` that only wires child scopes) -- it just has
 * no `_script` registrations, so there is nothing for `init()` to run and the
 * bundle would be dead weight on every request. `hasClientCode` detects that
 * and the page ships no bundle and no script tag at all.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import compiler from "@marko/compiler";

const require = createRequire(import.meta.url);
const TRANSLATOR = require.resolve("@marko/runtime-tags/translator");

/** Default URL prefix the generated `<script src>` is built from. */
export const DEFAULT_CLIENT_URL = "/.marko-go/client/";

/** Default output directory, relative to the generate root. */
export const DEFAULT_CLIENT_DIR = path.join(".marko-go", "client");

/**
 * Compile one template to its DOM-target JS.
 *
 * Deliberately the same call shape as compile.mjs's `compileMarko` -- same
 * translator, same `optimize: true`, same absolute path -- differing only in
 * `output`. That sameness is what makes the registry ids agree.
 */
export async function compileMarkoDom(markoPath) {
  const src = fs.readFileSync(markoPath, "utf8");
  const result = await compiler.compile(src, canonicalPath(markoPath), {
    translator: TRANSLATOR,
    output: "dom",
    optimize: true,
  });
  return result.code;
}

/**
 * The one path spelling every compile must use.
 *
 * Registry ids hash the absolute path, and a path can be spelled more than one
 * way: on macOS `/var` is a symlink to `/private/var`, so a temp directory has
 * two equally valid absolute names. That matters because bundlers resolve
 * imports through `realpath` -- Bun hands this module's plugin
 * `/private/var/.../ui-button.marko` while `generateProject`, walking the
 * directory it was given, holds `/var/.../ui-button.marko`. Same file, two
 * paths, two id sets: the payload references ids nothing registered and the
 * page renders perfectly while being completely inert.
 *
 * This was not hypothetical -- it is exactly what happened the first time this
 * pipeline ran against a temp-directory fixture, and it is why the id
 * cross-check exists. Normalizing here means both halves hash the same string
 * no matter which spelling they were handed.
 */
export function canonicalPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    // A path that cannot be resolved (deleted mid-build) is left as-is; the
    // compile is about to fail for a better reason.
    return p;
  }
}

/**
 * Registry ids referenced by a compiled module, as a sorted array.
 *
 * Both targets spell a registration the same way -- `_script("<id>", ...)` in
 * dom, `_script(scopeId, "<id>")` in html -- and both also carry `_content` /
 * `_content_resume` / `_template` ids. Matching on the id LITERAL rather than
 * on call shape keeps this robust to argument-order differences between the
 * two targets, at the cost of being a superset; that is the right side to err
 * on, because a false mismatch is a loud generation failure while a missed one
 * is a silently dead page.
 */
export function extractRegistryIds(code) {
  const ids = new Set();
  const re = /\b(?:_script|_content|_content_resume|_template)\(\s*"([^"]+)"/g;
  for (let m; (m = re.exec(code)); ) ids.add(m[1]);
  // The html target passes the scope id first: `_script($scope1_id, "id")`.
  const htmlScript = /\b_script\(\s*[^,)"]+,\s*"([^"]+)"\s*\)/g;
  for (let m; (m = htmlScript.exec(code)); ) ids.add(m[1]);
  return [...ids].sort();
}

/**
 * Does this dom compile register any client code?
 *
 * `_script("id", fn)` is the registration `init()` looks for. A page whose dom
 * module has none has nothing to hydrate.
 */
export function hasClientCode(domCode) {
  return /\b_script\(\s*"/.test(domCode);
}

/**
 * Fail generation if the html and dom compiles of the same template disagree
 * about registry ids.
 *
 * See the module header: a mismatch produces a page that looks perfect and is
 * completely inert, so this is checked rather than assumed. The ids come from
 * the very same `markoPath` in the same `generateProject` run, so agreement is
 * expected -- this catches the ways that could stop being true (a compiler
 * change, a caching layer handing back a stale compile, a future refactor that
 * compiles the two halves from different roots).
 */
export function assertRegistryIdsAgree(markoPath, htmlCode, domCode) {
  const htmlIds = new Set(extractRegistryIds(htmlCode));
  const domIds = new Set(extractRegistryIds(domCode));
  // The html target's own registry ids must all be registered by the dom
  // build. The reverse is not required: the dom module can carry ids for
  // things the html render never reached (an untaken branch).
  const missing = [...htmlIds].filter((id) => !domIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `registry ids disagree between the html and dom compiles of ${markoPath}: ` +
        `${missing.join(", ")} appear in the server payload but are not registered by the client bundle. ` +
        "Registry ids hash the template's ABSOLUTE path, so this usually means the two compiles saw different paths.",
    );
  }
}

/**
 * The browser entry module for one page.
 *
 * Written as source rather than assembled from the dom compile directly so
 * Bun resolves the template's own `.marko` imports (its layout, its tags)
 * through the same loader, transitively -- a page bundle has to carry every
 * template that renders inside it, or their setup closures go unregistered.
 */
export function buildEntryModule(markoPath) {
  return [
    "// Generated by marko-go. Browser entry for one page.",
    "//",
    "// Importing the dom-target template registers every setup closure under",
    "// the registry id the server's resume payload references; init() then",
    "// walks the markers, materializes the scopes from M._.r, and runs them.",
    `import ${JSON.stringify(markoPath)};`,
    // The dom runtime is imported by RESOLVED ABSOLUTE PATH, not by its bare
    // specifier. The entry is written next to the template, and a Go project
    // has no reason to carry node_modules -- an installed marko-go must bundle
    // ITS OWN pinned @marko/runtime-tags (the same version the server half's
    // payload targets), never whatever the user's tree happens to hold.
    `import { init } from ${JSON.stringify(DOM_RUNTIME)};`,
    "",
    "init();",
    "",
  ].join("\n");
}

/**
 * Absolute path to this package's pinned browser runtime. Resolved once, from
 * HERE, for the reason spelled out in buildEntryModule and in compile.mjs's
 * TRANSLATOR: our own dependency is the one that must be used.
 */
const DOM_RUNTIME = require.resolve("@marko/runtime-tags/dom");

/**
 * Bundle one page for the browser.
 *
 * Returns `null` when the page has no client code -- the caller ships no
 * bundle and no script tag, so a static page costs a browser exactly nothing.
 *
 * Bun is the bundler because it is already this package's test runner and can
 * compile `.marko` imports in-process through a plugin, which is what lets the
 * entry be two lines instead of a hand-assembled dependency graph.
 *
 * @param {string} markoPath  absolute path to the PAGE template
 * @param {string} htmlCode   its html-target compile, for the id cross-check
 * @returns {Promise<{code: string, ids: string[]} | null>}
 */
export async function bundlePage(markoPath, htmlCode) {
  const domCode = await compileMarkoDom(markoPath);
  assertRegistryIdsAgree(markoPath, htmlCode, domCode);
  if (!hasClientCode(domCode)) return null;

  const { Bun } = globalThis;
  if (!Bun?.build) {
    throw new Error(
      "client bundling needs Bun (Bun.build). Run marko-go under bun, or pass --no-client to skip the browser half.",
    );
  }

  const entryPath = path.join(
    path.dirname(markoPath),
    `.marko-go-entry-${path.basename(markoPath, ".marko")}.mjs`,
  );
  fs.writeFileSync(entryPath, buildEntryModule(markoPath));
  try {
    const result = await Bun.build({
      entrypoints: [entryPath],
      format: "esm",
      target: "browser",
      minify: true,
      plugins: [markoDomPlugin()],
    });
    if (!result.success) {
      throw new Error(
        `client bundle failed for ${markoPath}: ${result.logs.map(String).join("; ")}`,
      );
    }
    const code = await result.outputs[0].text();
    // The check that actually matters: the ids in the SHIPPED BUNDLE, not just
    // in the two pre-bundle compiles. The bundler resolves imports its own way
    // (through realpath, and through its own plugin for every transitive
    // `.marko`), so it is the one component that can reintroduce a path
    // mismatch after everything upstream agreed -- which is exactly what it
    // did the first time this ran against a temp-directory fixture. See
    // canonicalPath.
    assertBundleRegistersServerIds(markoPath, htmlCode, code);
    return { code, ids: extractRegistryIds(domCode) };
  } finally {
    fs.rmSync(entryPath, { force: true });
  }
}

/**
 * Fail if a registry id the SERVER will write is absent from the bundled
 * output.
 *
 * Only `_script` ids are checked. Those are the ones the payload's effects
 * string names and `init()` looks up, so a missing one is precisely the
 * "renders perfectly, completely inert" failure. `_content`/`_template` ids
 * can legitimately be optimized away by the bundler when nothing references
 * them at runtime.
 */
function assertBundleRegistersServerIds(markoPath, htmlCode, bundleCode) {
  const scriptIds = new Set(
    [...htmlCode.matchAll(/\b_script\(\s*[^,)"]+,\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
  );
  const missing = [...scriptIds].filter((id) => !bundleCode.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `client bundle for ${markoPath} does not register ${missing.join(", ")}, ` +
        "which the server's resume payload references. The page would render correctly and be completely inert. " +
        "Registry ids hash the template's ABSOLUTE path, so this means the bundler compiled a different path spelling than the server half.",
    );
  }
}

/**
 * Bun plugin compiling every `.marko` import -- the entry's own and every
 * transitive one -- with the same compiler/translator/optimize settings the
 * server half uses, at the file's real absolute path so registry ids match.
 */
function markoDomPlugin() {
  return {
    name: "marko-go-dom",
    setup(build) {
      // Compiled dom modules import `@marko/runtime-tags/dom` by BARE
      // specifier, and they live under the user's project, which has no reason
      // to carry node_modules. Point every such import at this package's
      // pinned copy -- the same one the server half's payload format was
      // reverse-engineered from, so the two halves cannot drift in version.
      build.onResolve({ filter: /^@marko\/runtime-tags(\/.*)?$/ }, (args) => ({
        path: require.resolve(args.path),
      }));
      build.onLoad({ filter: /\.marko$/ }, async (args) => ({
        contents: await compileMarkoDom(args.path),
        loader: "js",
      }));
    },
  };
}

/**
 * The URL a page's bundle is served from, given the CLI's `--client-url` base.
 * Kept next to the writer so the two cannot drift.
 */
export function clientBundleURL(urlBase, pageName) {
  return (urlBase.endsWith("/") ? urlBase : urlBase + "/") + pageName + ".js";
}

/** The file name a page's bundle is written under, within the client dir. */
export function clientBundleName(root, markoPath) {
  // Relative to the generate root, with separators flattened, so two pages
  // with the same basename in different directories cannot collide.
  const rel = path.relative(root, markoPath).replace(/\.marko$/, "");
  return rel.split(path.sep).join("-");
}
