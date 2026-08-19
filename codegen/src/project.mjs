import fs from "node:fs";
import path from "node:path";
import { compileMarko } from "./compile.mjs";
import { transpile } from "./transpile.mjs";
import { UnsupportedError } from "./errors.mjs";
import { parseInputInterface } from "./inputstruct.mjs";
import { pascalCase, sanitizePackageName } from "./names.mjs";

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
    const source = fs.readFileSync(file, "utf8");
    const fields = parseInputInterface(source, file);
    registry.set(file, {
      markoPath: file,
      dir,
      kebab,
      pascalName: pascalCase(kebab),
      pkgName: sanitizePackageName(path.basename(dir)),
      goImportPath: relDir === "" ? modulePath : `${modulePath}/${relDir}`,
      outPath: path.join(dir, `${kebab}.marko.go`),
      source,
      fields,
      inputFields: new Map(fields.map((f) => [f.name, f.goType])),
    });
  }
  return registry;
}

/**
 * Generate Go for every template under `root`.
 *
 * @param {string} root directory to walk
 * @param {{write?: boolean}} [opts] when write is false, nothing touches disk
 * @returns {{markoPath: string, outPath: string, code: string}[]}
 */
export async function generateProject(root, { write = true } = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new UnsupportedError(`not a directory: ${abs}`);
  }
  const mod = findGoModule(abs);
  const registry = buildRegistry(abs, mod);
  const results = [];

  for (const entry of registry.values()) {
    const js = await compileMarko(entry.markoPath);

    // Aliases are per generated FILE: every cross-directory dependency is
    // imported under its package name, with a numeric suffix on collision
    // (two directories can legitimately share a base name).
    const aliasByPath = new Map();
    const takenAliases = new Set([entry.pkgName, "runtime"]);

    const resolveTag = (specifier) => {
      const depPath = path.resolve(entry.dir, specifier);
      const dep = registry.get(depPath);
      if (!dep) return null;
      const sameDir = dep.dir === entry.dir;
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
      resolveTag,
    });

    if (write) fs.writeFileSync(entry.outPath, code);
    results.push({ markoPath: entry.markoPath, outPath: entry.outPath, code });
  }

  return results;
}
