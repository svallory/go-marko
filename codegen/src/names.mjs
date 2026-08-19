/**
 * Shared name mangling. A `.marko` file's kebab basename is the single
 * source of truth for every Go identifier derived from it:
 *
 *   ui-button.marko -> UiButton      (exported func + `UiButtonInput` struct)
 *                   -> uiButton      (prefix for module-level consts)
 *
 * Marko itself does the same kebab->camel mapping when it generates the
 * import binding for a custom tag (`import _uiButton from "./ui-button.marko"`),
 * which is what lets the transpiler match a call back to its template.
 */

/** `ui-button` -> `UiButton` */
export function pascalCase(kebab) {
  return kebab
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** `ui-button` -> `uiButton` */
export function camelCase(kebab) {
  const p = pascalCase(kebab);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

/** `class` -> `Class`, `dataFoo` -> `DataFoo`. Go exported-field convention. */
export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Go package name from a directory base name: lowercase, drop anything
 * outside [a-z0-9_]. `ui/tags/elements` -> `elements`.
 */
export function sanitizePackageName(dirBase) {
  const cleaned = dirBase.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (cleaned === "" || /^[0-9]/.test(cleaned)) return "pkg" + cleaned;
  return cleaned;
}

export function goStringLiteral(s) {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}
