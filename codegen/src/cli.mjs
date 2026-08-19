#!/usr/bin/env node
import path from "node:path";
import { generateProject } from "./project.mjs";
import { UnsupportedError } from "./errors.mjs";

const [, , command, dir] = process.argv;

if (command !== "generate" || !dir) {
  console.error("usage: marko-go generate <dir>");
  console.error("");
  console.error("  Walks <dir> for **/*.marko, compiles each one, and writes");
  console.error("  <name>.marko.go next to the source. Requires a go.mod at or");
  console.error("  above <dir> so Go import paths can be derived.");
  process.exit(1);
}

try {
  const results = await generateProject(dir);
  const root = path.resolve(dir);
  for (const r of results) {
    console.log(`  ${path.relative(root, r.outPath)}`);
  }
  console.log(
    `marko-go: generated ${results.length} file${results.length === 1 ? "" : "s"} from ${root}`,
  );
} catch (err) {
  if (err instanceof UnsupportedError) {
    console.error(`marko-go: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
