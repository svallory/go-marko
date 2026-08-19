#!/usr/bin/env node
import path from "node:path";
import { generateProject } from "./project.mjs";
import { UnsupportedError } from "./errors.mjs";

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
  -h, --help              show this help

examples:
  # one-shot: generate and exit (reports every failing template, non-zero)
  marko-go generate ./ui

  # watch: regenerate, restart the server, live-reload the browser
  marko-go generate --watch --proxy="http://localhost:8090" \\
    --cmd="go run -buildvcs=false ." ./ui

  Then open the proxy URL (http://localhost:7331), not the app's own port --
  only the proxy serves the reload script.
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
  const out = { watch: false, proxyPort: 7331, help: false };
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
async function generateOnce(dir) {
  const root = path.resolve(dir);
  const { goFiles, jsAssets, diagnostics } = await generateProject(dir, {
    bestEffort: true,
  });
  // Both output channels print the same way; jsAssets is empty until the
  // resumability wave starts emitting client bundles (see project.mjs).
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
      });
      return 0;
    }
    return await generateOnce(opts.dir);
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
  process.exit(await main(process.argv.slice(2)));
}
