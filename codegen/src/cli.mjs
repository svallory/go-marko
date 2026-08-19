#!/usr/bin/env node
import path from "node:path";
import { generateProject } from "./project.mjs";
import { DEFAULT_CLIENT_URL } from "./clientbundle.mjs";
import { UnsupportedError } from "./errors.mjs";

/**
 * Build the argv for re-executing this same CLI invocation under `bun`.
 *
 * A global install (`npm i -g marko-go`, `bun link`) can leave the `marko-go`
 * shim on PATH pointing at a `node` shebang, or a user's shell/package
 * manager may otherwise launch `cli.mjs` under plain node. Client bundling
 * needs `Bun.build`, which only exists inside the bun runtime -- there is no
 * node polyfill for it -- so a node-launched run must hand the SAME argv to
 * a `bun` child process rather than fail outright.
 *
 * Kept pure and exported so the argv construction is unit-testable without
 * actually spawning a process.
 *
 * @param {string[]} argv  process.argv (script path included, as node/bun set it)
 * @returns {string[]} argv to pass to `spawn("bun", ...)`
 */
export function buildBunReexecArgv(argv) {
  // argv[0] is the node/bun binary, argv[1] is this script's path -- bun run
  // <script> [...userArgs] reconstructs the same invocation faithfully.
  return [argv[1], ...argv.slice(2)];
}

/**
 * If not already running under bun, re-exec this exact invocation under
 * `bun` and resolve with its exit code -- otherwise resolve with `null` so
 * the caller proceeds normally.
 *
 * Always re-execs (never tries to guess whether this particular run needs
 * client bundling): predicting that from flags alone would have to special-
 * case --no-client, --watch's per-change regenerate, and any future flag
 * that touches bundling, and would still be wrong the moment a "no bundling
 * needed" run's templates gain client code. Re-exec is cheap and uniform.
 *
 * @returns {Promise<number | null>}
 */
async function reexecUnderBunIfNeeded() {
  if (typeof Bun !== "undefined") return null;

  const { spawn } = await import("node:child_process");
  const bunArgv = buildBunReexecArgv(process.argv);

  return new Promise((resolve, reject) => {
    const child = spawn("bun", bunArgv, { stdio: "inherit" });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        console.error(
          "marko-go: requires bun for client bundling -- install from https://bun.sh",
        );
        resolve(1);
        return;
      }
      reject(err);
    });
    child.on("exit", (code, signal) => {
      // A child killed by a signal (e.g. Ctrl-C forwarded via inherited
      // stdio) has no exit code; mirror the shell convention of 128+signal
      // rather than resolving null into a Node exit code.
      if (code === null) {
        resolve(signal ? 128 : 1);
        return;
      }
      resolve(code);
    });
  });
}

export const USAGE = `marko-go -- compile Marko templates to Go

usage:
  marko-go generate [flags] <dir>

  Walks <dir> for **/*.marko, compiles each one, and writes <name>.marko.go
  next to the source. Requires a go.mod at or above <dir> so Go import paths
  can be derived.

flags:
  --watch                 stay running; regenerate on every .marko change
  --cmd=<command>         with --watch: shell command to (re)start after each
                          successful regenerate (previous run is killed first)
  --proxy=<url>           with --watch: reverse-proxy this app URL and inject
                          a live-reload script into HTML responses
  --proxy-port=<port>     port the reload proxy listens on (default 7331)
  --client-dir=<dir>      where page client bundles are written
                          (default <dir>/.marko-go/client)
  --client-url=<base>     URL base the generated <script src> uses
                          (default /.marko-go/client/)
  --no-client             skip the browser half entirely: no bundles, and no
                          script tag in the generated Go. A page then renders
                          and serves normally but never hydrates.
  -h, --help              show this help

examples:
  # one-shot: generate and exit (reports every failing template, non-zero)
  marko-go generate ./ui

  # watch: regenerate, restart the server, live-reload the browser
  marko-go generate --watch --proxy="http://localhost:8090" \\
    --cmd="go run -buildvcs=false ." ./ui

  Then open the proxy URL (http://localhost:7331), not the app's own port --
  only the proxy serves the reload script.

client bundles:
  A PAGE -- a template no other template imports -- whose compiled client code
  is non-empty also gets a browser bundle, and its generated Go emits a
  <script type="module" src=...> for it. The bundle is written to
  <client-dir>/<page>.js (default <dir>/.marko-go/client/<page>.js) and the
  script tag points at <client-url><page>.js (default /.marko-go/client/,
  relative to <dir> -- see --client-dir/--client-url above), so mounting is
  one line:

    marko.MountClientAssets(mux, "ui/.marko-go/client")

  Passed a custom --client-url, use MountClientAssetsAt(mux, urlPrefix, dir)
  instead. A page with no reactivity ships no bundle and no script tag.

requirements:
  Client bundling uses Bun.build, so marko-go always re-execs itself under
  bun. If bun is not on PATH, generate fails with a clear error; install it
  from https://bun.sh. This applies even if you installed marko-go with npm.
`;

/**
 * Parse argv (everything after `node cli.mjs`) into a command descriptor.
 *
 * Kept pure and exported so flag handling is unit-testable without spawning
 * a process. Both `--flag=value` and `--flag value` are accepted, because
 * users copying the templ command line write either.
 *
 * @param {string[]} argv
 * @returns {{command?: string, dir?: string, watch: boolean, cmd?: string,
 *            proxy?: string, proxyPort: number, help: boolean,
 *            error?: string}}
 */
export function parseArgs(argv) {
  const out = {
    watch: false,
    proxyPort: 7331,
    help: false,
    client: true,
    clientDir: undefined,
    clientURL: DEFAULT_CLIENT_URL,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help" || arg === "help") {
      out.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) {
        out.error = `--${name} requires a value`;
        return undefined;
      }
      return next;
    };

    switch (name) {
      case "watch":
        out.watch = inlineValue === undefined ? true : inlineValue !== "false";
        break;
      case "cmd":
        out.cmd = takeValue();
        break;
      case "proxy":
        out.proxy = takeValue();
        break;
      case "proxy-port": {
        const raw = takeValue();
        if (raw !== undefined) {
          const port = Number(raw);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            out.error = `--proxy-port must be a port number, got ${raw}`;
          } else {
            out.proxyPort = port;
          }
        }
        break;
      }
      case "client-dir":
        out.clientDir = takeValue();
        break;
      case "client-url":
        out.clientURL = takeValue();
        break;
      case "no-client":
        out.client = inlineValue === undefined ? false : inlineValue === "false";
        break;
      default:
        out.error = `unknown flag: ${arg}`;
    }
  }

  out.command = positionals[0];
  out.dir = positionals[1];

  if (!out.help && !out.error) {
    if (out.command !== "generate") {
      out.error = out.command
        ? `unknown command: ${out.command}`
        : "missing command";
    } else if (!out.dir) {
      out.error = "missing <dir>";
    } else if (positionals.length > 2) {
      out.error = `unexpected argument: ${positionals[2]}`;
    } else if (!out.watch && (out.cmd || out.proxy)) {
      out.error = "--cmd and --proxy only apply with --watch";
    } else if (!out.client && (out.clientDir || out.clientURL !== DEFAULT_CLIENT_URL)) {
      out.error = "--client-dir and --client-url conflict with --no-client";
    }
  }

  return out;
}

/**
 * One-shot generate: print each generated file, then a summary.
 *
 * Errors are collected across the WHOLE project rather than aborting on the
 * first bad template, and each one is prefixed with the source .marko path
 * relative to the generate root -- exactly like watch mode. A batch run that
 * reported only the first failure would make fixing N broken templates take N
 * runs, and an unprefixed "unsupported Marko feature: …" gives no clue which
 * of the project's templates to open. The run still exits non-zero.
 *
 * @returns {Promise<number>} process exit code
 */
async function generateOnce(dir, opts) {
  const root = path.resolve(dir);
  const { goFiles, jsAssets, diagnostics } = await generateProject(dir, {
    bestEffort: true,
    client: opts.client,
    clientDir: opts.clientDir ? path.resolve(opts.clientDir) : null,
    clientURL: opts.clientURL,
  });
  // Both output channels print the same way: goFiles is the Go next to each
  // template, jsAssets the per-page browser bundles.
  const written = [...goFiles, ...jsAssets];
  for (const r of written) {
    console.log(`  ${path.relative(root, r.outPath)}`);
  }
  if (diagnostics.length) {
    for (const { markoPath, error } of diagnostics) {
      console.error(`marko-go: ${path.relative(root, markoPath)}: ${error.message}`);
    }
    console.error(
      `marko-go: ${diagnostics.length} of ${goFiles.length + diagnostics.length} template${
        goFiles.length + diagnostics.length === 1 ? "" : "s"
      } failed`,
    );
    return 1;
  }
  console.log(
    `marko-go: generated ${written.length} file${written.length === 1 ? "" : "s"} from ${root}`,
  );
  return 0;
}

export async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.error) {
    console.error(`marko-go: ${opts.error}`);
    console.error("");
    console.error(USAGE);
    return 1;
  }

  try {
    if (opts.watch) {
      // Loaded lazily so one-shot runs never pay for chokidar.
      const { watch } = await import("./watch.mjs");
      await watch({
        dir: opts.dir,
        cmd: opts.cmd,
        proxy: opts.proxy,
        proxyPort: opts.proxyPort,
        // Client bundles regenerate with everything else -- watch mode does a
        // full regenerate per change, so the browser half stays in step with
        // the payload it has to match.
        client: opts.client,
        clientDir: opts.clientDir ? path.resolve(opts.clientDir) : null,
        clientURL: opts.clientURL,
      });
      return 0;
    }
    return await generateOnce(opts.dir, opts);
  } catch (err) {
    if (err instanceof UnsupportedError) {
      console.error(`marko-go: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

// Only run when invoked as the binary, so tests can import parseArgs/main.
if (import.meta.main ?? process.argv[1]?.endsWith("cli.mjs")) {
  // Client bundling needs Bun.build, which does not exist under plain node --
  // re-exec under bun BEFORE anything else runs, so a node-launched global
  // install (npm/bun link shims can point at either) still works.
  const reexecCode = await reexecUnderBunIfNeeded();
  if (reexecCode !== null) {
    process.exit(reexecCode);
  }
  process.exit(await main(process.argv.slice(2)));
}
