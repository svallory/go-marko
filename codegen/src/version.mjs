/**
 * Lockstep version between the npm package `marko-go` and the Go runtime it
 * targets.
 *
 * There is exactly ONE version, sourced from `codegen/package.json`. A git
 * tag `vX.Y.Z` releases both halves at once: `npm publish` of marko-go, and
 * the Go module tag `github.com/svallory/go-marko@vX.Y.Z` -- Go modules use
 * repo tags directly, so the same tag serves both by construction.
 *
 * What this module solves: codegen and runtime are versioned together but
 * COMPILED separately (npm install vs. `go get`), so nothing stops a user
 * from running an old `marko-go` CLI against a newer `runtime` package (or
 * vice versa) after an independent `go get -u` / `bun update`. A MINOR or
 * MAJOR mismatch can change the Go API codegen emits calls against (new
 * Writer methods, renamed intrinsics, etc.), so that combination must fail
 * loudly. A PATCH difference never changes the generated-code contract (bug
 * fixes only), so it must NOT break the build.
 *
 * Mechanism: every generated `.marko.go` file references one identifier
 * named after its MINOR version, e.g.
 *
 *   var _ = runtime.GeneratedByMarkoGo_v0_1
 *
 * `runtime` exports that exact identifier (see runtime/version.go) for every
 * minor version it supports. If the installed `runtime` package predates the
 * codegen that produced the file, or has moved on to a later minor that
 * dropped the old sentinel, `go build` fails with a plain, greppable error:
 *
 *   undefined: runtime.GeneratedByMarkoGo_v0_1
 *
 * which is enough for a user to know "update your runtime (or your
 * marko-go)" without any custom tooling. The check costs nothing at runtime
 * -- the reference compiles to nothing, since the identifier is a constant
 * read whose value is discarded.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.join(HERE, "..", "package.json");

/**
 * Parse `X.Y.Z` (optionally with a `-prerelease`/`+build` suffix, which is
 * ignored -- the sentinel only ever encodes major.minor) into its parts.
 *
 * @param {string} version
 * @returns {{major: string, minor: string, patch: string}}
 */
export function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) {
    throw new Error(`marko-go: package.json "version" is not semver: ${version}`);
  }
  const [, major, minor, patch] = m;
  return { major, minor, patch };
}

/**
 * The Go identifier generated code references to assert runtime
 * compatibility, e.g. `GeneratedByMarkoGo_v0_1` for version `0.1.0`.
 *
 * Deliberately keyed on major.minor only: a patch bump must never require
 * regenerating output or force a runtime upgrade.
 *
 * @param {string} version semver `X.Y.Z`
 * @returns {string}
 */
export function versionSentinelName(version) {
  const { major, minor } = parseVersion(version);
  return `GeneratedByMarkoGo_v${major}_${minor}`;
}

/** Read and cache codegen's own package.json version (`marko-go`'s version). */
let cachedVersion;
export function readPackageVersion() {
  if (cachedVersion === undefined) {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}
