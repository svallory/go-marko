import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import compiler from "@marko/compiler";
const require = createRequire("/Users/svallory/work/go-marko/worktrees/fr1-composition/codegen/src/compile.mjs");
const TRANSLATOR = require.resolve("@marko/runtime-tags/translator");
const f = process.argv[2];
const r = await compiler.compile(fs.readFileSync(f,"utf8"), f, {translator:TRANSLATOR, output:"dom", optimize:true});
console.log(r.code);
