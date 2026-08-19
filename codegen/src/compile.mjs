import compiler from "@marko/compiler";
import fs from "node:fs";
import { createRequire } from "node:module";

/**
 * Resolve the translator to an absolute path ONCE, relative to this file.
 *
 * Passing the bare specifier `"@marko/runtime-tags/translator"` makes
 * @marko/compiler resolve it against the file being compiled (really, against
 * a synthetic `/noop.js`), which works only when the user's project happens
 * to have marko installed. For an installed CLI -- `bunx marko-go`, or a
 * global install run inside a Go project with no node_modules at all -- that
 * fails with "Cannot find module '@marko/runtime-tags/translator'". Our own
 * dependency is the one that must be used, so we resolve it from here.
 */
const TRANSLATOR = createRequire(import.meta.url).resolve(
  "@marko/runtime-tags/translator",
);

/**
 * Compiles a .marko file to its `html`-target JS source, using the
 * unmodified @marko/compiler + @marko/runtime-tags translator. This step
 * is not touched by marko-go -- it's exactly what a normal Marko project
 * does. What comes after (transpile.mjs) is ours.
 *
 * @param {string} markoPath
 * @returns {Promise<string>} compiled JS source
 */
export async function compileMarko(markoPath) {
  const src = fs.readFileSync(markoPath, "utf8");
  const result = await compiler.compile(src, markoPath, {
    translator: TRANSLATOR,
    output: "html",
    optimize: true,
  });
  return result.code;
}
