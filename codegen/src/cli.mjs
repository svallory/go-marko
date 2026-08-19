#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { compileMarko } from "./compile.mjs";
import { transpile, UnsupportedError } from "./transpile.mjs";

const [, , markoPath, outDir, goPackage = "views"] = process.argv;

if (!markoPath || !outDir) {
  console.error("usage: marko-go-codegen <template.marko> <out-dir> [go-package-name]");
  process.exit(1);
}

const js = await compileMarko(markoPath);

try {
  const go = transpile(js, { goPackage });
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "render.go");
  fs.writeFileSync(outFile, go);
  console.log(`wrote ${outFile}`);
} catch (err) {
  if (err instanceof UnsupportedError) {
    console.error(`${markoPath}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
