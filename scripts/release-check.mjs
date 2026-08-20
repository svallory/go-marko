#!/usr/bin/env bun
/**
 * Release-readiness gate for the lockstep version between the npm package
 * `marko-go` (packages/marko-go/) and the Go module github.com/svallory/go-marko
 * (runtime/). Run in CI (and locally before tagging a release) to catch a
 * drifted version BEFORE it ships, rather than surfacing as a confusing
 * `go build` error for a downstream user.
 *
 * Asserts three things agree:
 *
 *   1. packages/marko-go/package.json's "version" -- the single source of truth.
 *   2. The version marker codegen actually EMITS into generated Go files
 *      (transpile a throwaway template through the real emit path and read
 *      the `var _ = runtime.GeneratedByMarkoGo_vX_Y` line back out).
 *   3. The sentinel constant `runtime` package EXPORTS for that
 *      major.minor (grepped from runtime/version.go's const block).
 *
 * A tag vX.Y.Z releases both halves at once (npm publish of marko-go + the
 * Go module tag), so if any of the three disagree, the release is broken:
 * either codegen forgot to bump its emitted marker, or runtime.go forgot to
 * add (or prematurely dropped) the constant for the version being released.
 *
 * Usage: bun scripts/release-check.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseVersion,
  versionSentinelName,
} from "../packages/marko-go/src/version.mjs";
import { transpile } from "../packages/marko-go/src/transpile.mjs";
import { compileMarko } from "../packages/marko-go/src/compile.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PACKAGE_JSON_PATH = path.join(ROOT, "packages", "marko-go", "package.json");
const RUNTIME_VERSION_GO_PATH = path.join(ROOT, "runtime", "version.go");

function fail(message) {
  console.error(`release-check: FAIL -- ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`release-check: ok -- ${message}`);
}

// --- 1. package.json version -----------------------------------------------

const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
const version = pkg.version;
if (typeof version !== "string" || version.length === 0) {
  fail(`packages/marko-go/package.json has no "version"`);
}
const { major, minor, patch } = parseVersion(version);
ok(`packages/marko-go/package.json version = ${version} (major=${major} minor=${minor} patch=${patch})`);

const expectedSentinel = versionSentinelName(version);

// --- 2. What codegen actually emits ----------------------------------------
//
// Compile a minimal throwaway template through the real pipeline
// (compileMarko + transpile, the same path project.mjs uses) and check the
// version sentinel line codegen embedded, rather than re-deriving it from
// version.mjs a second time -- that would only prove version.mjs agrees with
// itself, not that emit.mjs actually wired it in.

const scratchDir = fs.mkdtempSync(path.join(ROOT, ".release-check-"));
let emittedSentinel;
try {
  const markoPath = path.join(scratchDir, "release-check-probe.marko");
  fs.writeFileSync(markoPath, "<div>release-check probe</div>\n");
  const js = await compileMarko(markoPath);
  const { code } = transpile(js, {
    goPackage: "releasecheckprobe",
    templateName: "release-check-probe",
    pascalName: "ReleaseCheckProbe",
  });
  const m = /var _ = runtime\.(\S+)/.exec(code);
  if (!m) {
    fail(
      "generated Go has no `var _ = runtime.<sentinel>` version marker -- " +
        "emit.mjs's version-sentinel wiring appears to be missing",
    );
  }
  emittedSentinel = m[1];
} finally {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (emittedSentinel !== expectedSentinel) {
  fail(
    `codegen emits "${emittedSentinel}" but package.json version ${version} ` +
      `implies "${expectedSentinel}" -- emit.mjs and version.mjs have drifted`,
  );
}
ok(`codegen emits var _ = runtime.${emittedSentinel}`);

// --- 3. What runtime exports -------------------------------------------------

const runtimeGoSrc = fs.readFileSync(RUNTIME_VERSION_GO_PATH, "utf8");
const constPattern = new RegExp(
  `\\b${expectedSentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
);
if (!constPattern.test(runtimeGoSrc)) {
  fail(
    `runtime/version.go does not export a constant named ${expectedSentinel} -- ` +
      `add it (see the const block's doc comment for the bump convention) ` +
      `before tagging v${version}`,
  );
}
ok(`runtime/version.go exports ${expectedSentinel}`);

console.log(
  `release-check: PASS -- packages/marko-go/package.json, emitted Go, and runtime/version.go ` +
    `all agree on marko-go v${version} (sentinel ${expectedSentinel})`,
);
