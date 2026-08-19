import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { goTypeForTS, goFieldName, renderInputStruct } from "./inputstruct.mjs";
import { sanitizePackageName } from "./names.mjs";
import { UnsupportedError } from "./errors.mjs";

/**
 * FR10 -- `$global`, Marko's request-scoped context (templ's `ctx` analogue).
 *
 * A template reads `$global.path` with no declaration of its own; the shape
 * lives in ONE project-wide TypeScript augmentation:
 *
 *   // ui/global.d.ts
 *   declare global {
 *     namespace Marko {
 *       interface Global { path: string }
 *     }
 *   }
 *
 * marko-go turns that interface into a Go struct (`ui.Globals`) emitted next
 * to the .d.ts, so the whole path -- handler to template -- is typed. There
 * is deliberately no fallback shape: without the .d.ts we have no field types
 * and no package to put them in, so `$global` usage is a hard error naming
 * the file to create.
 */

/** File name the Go struct is written to, alongside the declaring .d.ts. */
export const GLOBALS_FILE = "globals.marko.go";

/** Go type name generated for the Marko.Global interface. */
export const GLOBALS_TYPE = "Globals";

/**
 * Find every `*.d.ts` under `root` that declares `namespace Marko { interface
 * Global }`, cheapest test first (a regex over the source) so a project full
 * of unrelated .d.ts files doesn't pay for parsing them all.
 *
 * Returns absolute paths, sorted, so a project with two declarations fails
 * deterministically rather than depending on directory order.
 */
export function findGlobalDeclarations(root) {
  const out = [];
  walk(root);
  return out.sort();

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.name.endsWith(".d.ts")) {
        const source = fs.readFileSync(full, "utf8");
        if (/namespace\s+Marko\b/.test(source) && /interface\s+Global\b/.test(source)) {
          out.push(full);
        }
      }
    }
  }
}

/**
 * Parse `interface Global { ... }` out of a .d.ts, from inside whatever
 * `declare global` / `namespace Marko` nesting it sits in. Field mapping is
 * the SAME TS->Go mapping as `interface Input` (inputstruct.mjs), so a
 * global and an input prop of the same TS type get the same Go type.
 *
 * Nested inline object types are not supported here: a globals struct is a
 * flat request-context bag, and nothing in the fixture space needs more.
 * They degrade to `map[string]any` (no ctx passed to goTypeForTS).
 */
export function parseGlobalInterface(source, dtsPath = "<global.d.ts>") {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
      errorRecovery: true,
    });
  } catch (err) {
    throw new UnsupportedError(`could not parse ${dtsPath}: ${err.message}`);
  }

  const decl = findGlobalInterface(ast.program.body);
  if (!decl) {
    throw new UnsupportedError(
      `${dtsPath} declares no \`namespace Marko { interface Global { ... } }\``,
    );
  }

  const fields = [];
  for (const member of decl.body.body) {
    if (!t.isTSPropertySignature(member)) {
      throw new UnsupportedError(
        `only plain properties are supported in \`interface Global\` (${dtsPath}), got ${member.type}`,
        member,
      );
    }
    const jsName = t.isIdentifier(member.key)
      ? member.key.name
      : t.isStringLiteral(member.key)
        ? member.key.value
        : null;
    if (jsName === null) {
      throw new UnsupportedError(
        `computed keys are not supported in \`interface Global\` (${dtsPath})`,
        member,
      );
    }
    fields.push({
      jsName,
      name: goFieldName(jsName),
      goType: goTypeForTS(member.typeAnnotation?.typeAnnotation),
      optional: !!member.optional,
    });
  }
  return fields;
}

/**
 * Depth-first search for the `interface Global` declaration, descending
 * through `declare global` (a TSModuleDeclaration whose id is the identifier
 * `global`), `namespace Marko`, and `export`/`declare` wrappers. Marko's own
 * documented augmentation nests it two levels deep, but nothing here depends
 * on the exact nesting.
 */
function findGlobalInterface(body) {
  for (const node of body) {
    const candidate = t.isExportNamedDeclaration(node) ? node.declaration : node;
    if (!candidate) continue;
    if (t.isTSInterfaceDeclaration(candidate) && candidate.id.name === "Global") {
      return candidate;
    }
    if (t.isTSModuleDeclaration(candidate) && candidate.body) {
      const inner = t.isTSModuleBlock(candidate.body)
        ? candidate.body.body
        : [candidate.body];
      const hit = findGlobalInterface(inner);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Locate and parse the project's Marko.Global declaration under `root`.
 *
 * @returns {null | {dtsPath: string, dir: string, pkgName: string,
 *                   goImportPath: string, outPath: string,
 *                   fields: object[], fieldTypes: Map<string,string>}}
 *   null when the project declares no globals -- which is legal (a project
 *   that never uses `$global` needs none); the transpiler turns `$global`
 *   usage without a declaration into an UnsupportedError.
 */
export function findGlobals(root, { modulePath, moduleRoot }) {
  const found = findGlobalDeclarations(root);
  if (found.length === 0) return null;
  if (found.length > 1) {
    throw new UnsupportedError(
      `more than one file declares \`Marko.Global\`: ${found.join(", ")} -- the request context must have a single definition`,
    );
  }
  const dtsPath = found[0];
  const dir = path.dirname(dtsPath);
  const relDir = path.relative(moduleRoot, dir).split(path.sep).join("/");
  const fields = parseGlobalInterface(fs.readFileSync(dtsPath, "utf8"), dtsPath);
  return {
    dtsPath,
    dir,
    pkgName: sanitizePackageName(path.basename(dir)),
    goImportPath: relDir === "" ? modulePath : `${modulePath}/${relDir}`,
    outPath: path.join(dir, GLOBALS_FILE),
    fields,
    fieldTypes: new Map(fields.map((f) => [f.name, f.goType])),
  };
}

/**
 * Render `globals.marko.go`. `runtime` is imported only when a field's Go
 * type actually mentions it (`runtime.Body` in a global would be odd, but
 * the mapping allows it) -- an unused import is a Go compile error.
 */
export function renderGlobalsFile(globals) {
  const needsRuntime = globals.fields.some((f) => f.goType.includes("runtime."));
  const parts = [
    "// Code generated by marko-go. DO NOT EDIT.",
    `package ${globals.pkgName}`,
    "",
  ];
  if (needsRuntime) {
    parts.push('import "github.com/svallory/go-marko/runtime"', "");
  }
  parts.push(
    `// ${GLOBALS_TYPE} is the request-scoped context every template can read as`,
    "// `$global.<field>`. Generated from the `Marko.Global` interface in",
    `// ${path.basename(globals.dtsPath)}.`,
    "//",
    "// Provide it per request with marko.WithGlobals; rendering without it",
    "// yields the zero value.",
    renderInputStruct(GLOBALS_TYPE, globals.fields),
    "",
  );
  return parts.join("\n");
}
