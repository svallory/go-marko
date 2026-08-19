import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { compileMarko } from "./compile.mjs";
import { transpile } from "./transpile.mjs";
import { UnsupportedError } from "./errors.mjs";
import { parseInputInterface } from "./inputstruct.mjs";
import { pascalCase, sanitizeNpmPackageName, sanitizePackageName } from "./names.mjs";

/** Directory name every vendored (node_modules) template's Go lands under. */
const MARKO_MODULES_DIR = "marko_modules";

/** Recursively collect `**\/*.marko` under `dir`, sorted for determinism. */
export function findMarkoFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...findMarkoFiles(full));
    } else if (entry.name.endsWith(".marko")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Walk up from `dir` looking for a go.mod, and read its module path. The Go
 * import path of any directory in the module is `<module>/<relative dir>`,
 * which is what lets one generated file import another package's tags.
 */
export function findGoModule(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    const candidate = path.join(cur, "go.mod");
    if (fs.existsSync(candidate)) {
      const m = fs
        .readFileSync(candidate, "utf8")
        .match(/^\s*module\s+(\S+)/m);
      if (!m) {
        throw new UnsupportedError(`${candidate} has no module directive`);
      }
      return { modulePath: m[1], moduleRoot: cur, goModPath: candidate };
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      throw new UnsupportedError(
        `no go.mod found at or above ${path.resolve(dir)} -- marko-go generate needs one to derive Go import paths`,
      );
    }
    cur = parent;
  }
}

/**
 * Read `fields`/`inputFields` for a template file, shared by project + vendor
 * entries. `pascalName` roots the names of any structs generated for inline
 * object types in the interface (`CounterInput.events` -> `CounterInputEvents`),
 * so it has to be known before the fields are parsed.
 */
function readTemplateFields(file, pascalName) {
  const source = fs.readFileSync(file, "utf8");
  const fields = parseInputInterface(source, file, `${pascalName}Input`);
  return {
    source,
    fields,
    nestedStructs: fields.nested,
    inputFields: new Map(fields.map((f) => [f.name, f.goType])),
  };
}

/**
 * Build the template registry: every .marko under `root`, keyed by its
 * absolute path, with everything a *caller* needs to emit a cross-package
 * call. Input fields are parsed here (from source) rather than in
 * transpile.mjs because a caller needs the *callee's* field types to decide
 * how to emit e.g. an `attrs` map.
 */
export function buildRegistry(root, { modulePath, moduleRoot }) {
  const registry = new Map();
  for (const file of findMarkoFiles(root)) {
    const dir = path.dirname(file);
    const relDir = path.relative(moduleRoot, dir).split(path.sep).join("/");
    const kebab = path.basename(file, ".marko");
    const pascalName = pascalCase(kebab);
    registry.set(file, {
      markoPath: file,
      dir,
      kebab,
      pascalName,
      pkgName: sanitizePackageName(path.basename(dir)),
      goImportPath: relDir === "" ? modulePath : `${modulePath}/${relDir}`,
      outPath: path.join(dir, `${kebab}.marko.go`),
      vendor: false,
      ...readTemplateFields(file, pascalName),
    });
  }
  return registry;
}

/**
 * Resolve a `.marko` import specifier that node resolution owns -- either a
 * bare specifier (`"fancy-tags/dist/tags/fancy-badge.marko"`) resolved from
 * the importing file's own directory, or (when the importing file is ITSELF
 * a vendor template) a relative specifier resolved the same way: a package
 * tag can import a sibling tag from its own package with `"./fancy-icon
 * .marko"`, and that must resolve within the SAME package, not be mistaken
 * for a project-relative import.
 *
 * This is exactly how @marko/compiler itself found the tag's taglib in the
 * first place (walking up from the compiled file's own package.json), so
 * the two agree on which node_modules tree is in play.
 *
 * Returns the npm package name (the specifier's first path segment, or
 * `@scope/name` for a scoped package -- always the IMPORTING file's own
 * package for a relative specifier) and the resolved absolute file path, or
 * null if it doesn't resolve to a `.marko` file.
 */
export function resolveVendorTemplate(specifier, importingFile, importingNpmName) {
  const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
  if (isRelative && !importingNpmName) return null; // project file: not our problem
  let resolved;
  try {
    resolved = createRequire(importingFile).resolve(specifier);
  } catch {
    return null;
  }
  if (!resolved.endsWith(".marko")) return null;
  const npmName = isRelative
    ? importingNpmName
    : specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
  return { npmName, file: resolved };
}

/**
 * Build (and memoize into `registry`) the entry for a vendored template
 * reached via a bare import specifier, or a relative one from within another
 * vendor template. Disambiguates same-basename templates within one package
 * by folding in their subpath -- packaging layout (e.g. `dist/tags/...`) is
 * otherwise flattened away, since it's build noise the consuming project
 * shouldn't have to know about.
 *
 * @param {string} [importingNpmName] set when `importingFile` is itself a
 *   vendor template, so a relative specifier can be resolved.
 * @returns the registry entry, or null if `specifier` doesn't resolve to a
 *   `.marko` file via node resolution.
 */
export function addVendorTemplate(
  registry,
  specifier,
  importingFile,
  { moduleRoot, modulePath },
  importingNpmName,
) {
  const hit = resolveVendorTemplate(specifier, importingFile, importingNpmName);
  if (!hit) return null;
  const existing = registry.get(hit.file);
  if (existing) return existing;

  const pkgDir = path.dirname(createRequire(importingFile).resolve(`${hit.npmName}/package.json`));
  const relInPkg = path.relative(pkgDir, hit.file).split(path.sep).join("/");
  const sanitizedPkg = sanitizeNpmPackageName(hit.npmName);
  const kebab = path.basename(hit.file, ".marko");

  // Same basename can appear at different subpaths within one package
  // (e.g. two "badge.marko" under different dirs) -- disambiguate by
  // folding the subpath into the emitted file/type name instead of the
  // flat basename. Detected lazily: only entries actually added collide.
  let outBase = kebab;
  let pascalName = pascalCase(kebab);
  for (const other of registry.values()) {
    if (other.vendor && other.sanitizedPkg === sanitizedPkg && other.kebab === kebab && other.markoPath !== hit.file) {
      const disambiguated = path
        .dirname(relInPkg)
        .split("/")
        .filter((s) => s && s !== "." && s !== "dist" && s !== "tags")
        .concat(kebab)
        .join("-");
      outBase = disambiguated || kebab;
      pascalName = pascalCase(outBase);
      break;
    }
  }

  const outDir = path.join(moduleRoot, MARKO_MODULES_DIR, sanitizedPkg);
  const entry = {
    markoPath: hit.file,
    dir: path.dirname(hit.file),
    kebab,
    pascalName,
    pkgName: sanitizedPkg,
    sanitizedPkg,
    npmName: hit.npmName,
    goImportPath: `${modulePath}/${MARKO_MODULES_DIR}/${sanitizedPkg}`,
    outPath: path.join(outDir, `${outBase}.marko.go`),
    vendor: true,
    ...readTemplateFields(hit.file, pascalName),
  };
  registry.set(hit.file, entry);
  return entry;
}

/**
 * Generate Go for every template under `root`.
 *
 * Without `bestEffort` the first bad template aborts the run by throwing.
 * With it, per-template errors are collected and generation continues past a
 * broken file (leaving its previously generated .go on disk), so the caller
 * can report ALL of them. Both the CLI's one-shot mode and watch mode use
 * `bestEffort`: a batch run should not make fixing N broken templates take N
 * runs, and a typo mid-edit must never take the watcher down. Failures that
 * aren't attributable to one template (a missing go.mod, a bad root) still
 * throw either way.
 *
 * @param {string} root directory to walk
 * @param {{write?: boolean, bestEffort?: boolean}} [opts] when write is
 *   false, nothing touches disk; when bestEffort is true, per-file errors are
 *   collected instead of thrown
 * @returns {Promise<{markoPath: string, outPath: string, code: string}[]> |
 *   Promise<{results: {markoPath: string, outPath: string, code: string}[],
 *            errors: {markoPath: string, error: Error}[]}>}
 */
export async function generateProject(root, { write = true, bestEffort = false } = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new UnsupportedError(`not a directory: ${abs}`);
  }
  const mod = findGoModule(abs);
  const registry = buildRegistry(abs, mod);
  const results = [];
  const errors = [];

  // Vendor (node_modules) templates are discovered lazily, while resolving
  // imports of project templates (or of OTHER vendor templates -- a package
  // tag can import a sibling tag from its own package). `registry` is a Map,
  // and entries `addVendorTemplate` adds during this `for` are still visited
  // by it: iterating a Map always sees keys added before the iterator
  // finishes, in insertion order. That is what makes recursive package-
  // internal imports "just work" with one flat loop.
  for (const entry of registry.values()) {
    try {
      results.push(await generateOne(entry, registry));
    } catch (err) {
      if (!bestEffort) throw err;
      errors.push({ markoPath: entry.markoPath, error: err });
    }
  }

  return bestEffort ? { results, errors } : results;

  async function generateOne(entry, registry) {
    const js = await compileMarko(entry.markoPath);

    // Aliases are per generated FILE: every cross-directory dependency is
    // imported under its package name, with a numeric suffix on collision
    // (two directories can legitimately share a base name).
    const aliasByPath = new Map();
    const takenAliases = new Set([entry.pkgName, "runtime"]);

    const resolveTag = (specifier) => {
      let dep;
      const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
      if (isRelative) {
        dep = registry.get(path.resolve(entry.dir, specifier));
        // A relative specifier inside a VENDOR template (a package tag
        // importing a sibling tag from its own package) doesn't live in the
        // project registry -- resolve it with node resolution too, scoped
        // to the importing template's own npm package.
        if (!dep && entry.vendor) {
          dep = addVendorTemplate(registry, specifier, entry.markoPath, mod, entry.npmName);
        }
      } else {
        // Bare specifier: `import _fancyBadge from "fancy-tags/dist/tags/
        // fancy-badge.marko"`. Resolve it with node resolution from the
        // FILE THAT IMPORTS IT -- for a project template that's the
        // project's own node_modules; for a vendor template that's the
        // package's own node_modules. We always resolve from `entry`,
        // never from codegen's own node_modules.
        dep = addVendorTemplate(registry, specifier, entry.markoPath, mod);
      }
      if (!dep) return null;
      // "same package" -- not "same source dir": a vendored package's tags
      // can live under different subdirectories (dist/tags/a/, dist/tags/b/)
      // yet all flatten into ONE Go package (goImportPath), so two such
      // tags calling each other must NOT be qualified -- that would compile
      // as a self-import cycle. goImportPath is what Go actually keys
      // packages by, and it agrees with `dir` for project templates (one
      // directory is always one Go package there) while correctly
      // collapsing vendor subdirectories to their single package.
      const sameDir = dep.goImportPath === entry.goImportPath;
      let alias = aliasByPath.get(dep.goImportPath);
      if (!sameDir && alias === undefined) {
        alias = dep.pkgName;
        for (let n = 2; takenAliases.has(alias); n++) alias = dep.pkgName + n;
        takenAliases.add(alias);
        aliasByPath.set(dep.goImportPath, alias);
      }
      return {
        pkgName: dep.pkgName,
        pascalName: dep.pascalName,
        goImportPath: dep.goImportPath,
        inputFields: dep.inputFields,
        sameDir,
        alias: alias ?? dep.pkgName,
      };
    };

    const { code } = transpile(js, {
      goPackage: entry.pkgName,
      templateName: entry.kebab,
      pascalName: entry.pascalName,
      inputFields: entry.fields,
      nestedStructs: entry.nestedStructs,
      resolveTag,
    });

    if (write) {
      fs.mkdirSync(path.dirname(entry.outPath), { recursive: true });
      fs.writeFileSync(entry.outPath, code);
    }
    return { markoPath: entry.markoPath, outPath: entry.outPath, code };
  }
}
