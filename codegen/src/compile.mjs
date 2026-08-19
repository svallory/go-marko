import compiler from "@marko/compiler";
import fs from "node:fs";

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
    translator: "@marko/runtime-tags/translator",
    output: "html",
    optimize: true,
  });
  return result.code;
}
