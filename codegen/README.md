# marko-go

Compile [Marko](https://markojs.com) templates into type-safe Go render
functions, with the same dev loop `templ` gives you: watch, regenerate,
restart the server, live-reload the browser.

```
ui/pages/landing.marko  ->  ui/pages/landing.marko.go   (package pages)
```

Each generated file exports a `Landing(w io.Writer, input LandingInput) error`
style function plus an `Input` struct derived from the template's
`export interface Input`, so calling a template from Go is a normal typed
function call and cross-template `<ui-button/>` composition becomes a normal
Go import.

## Install

```sh
bun add -g marko-go     # global install
bunx marko-go --help    # or run it without installing
```

npm/pnpm/yarn work too (`npm i -g marko-go`, `npx marko-go`). Requires Node
>= 20.19.

## Generate

```sh
marko-go generate ./ui
```

Walks `./ui` for `**/*.marko`, compiles each one, and writes
`<name>.marko.go` next to the source. A `go.mod` must exist at or above the
directory — its module path is what lets one generated package import
another. Add `*.marko.go` to `.gitignore`; the files are build output.

One-shot mode is fail-fast: the first template that uses an unsupported
construct aborts the run with a pointed error and a non-zero exit status.

## Tag packages (npm)

A `.marko` file can use a custom tag installed from npm, exactly like a
regular Marko project:

```sh
bun add fancy-tags
```

```marko
<fancy-badge label="new"/>
```

Two things make this work, both standard Marko conventions -- marko-go
doesn't add any of its own:

1. Your project's `package.json` must list the package as a **dependency**
   (`bun add` does this for you). That's how Marko's own taglib discovery
   finds the package's tags in the first place -- it isn't enough for the
   package to merely exist in `node_modules`.
2. The package's root `marko.json` must point at a directory of `.marko`
   files, e.g. `{ "exports": "./dist/tags" }`. Any package that ships tags
   for Marko already does this; it's how `<fancy-badge/>` resolves to
   `fancy-tags/dist/tags/fancy-badge.marko`.

`marko-go generate` compiles every such tag your project actually uses (and,
recursively, any tag *that* tag imports from the same package) the same way
it compiles your own templates. The generated Go doesn't live next to your
`.marko` files, though -- vendored tags aren't yours to edit, so they get
their own tree:

```
<go-mod-root>/marko_modules/<sanitized-pkg>/<template>.marko.go
```

`<sanitized-pkg>` is the npm package name, lowercased, with `@scope/name`
becoming `scope_name` and anything outside `[a-z0-9_]` collapsed to `_`
(never a leading `_` or digit -- Go tooling silently skips directories
whose name starts with `_` or `.`, and this doubles as the Go package name).
The package's own internal path (`dist/tags/...`) is dropped; only on a
name collision within one package does the subpath get folded back in to
disambiguate.

Calling a vendored tag from your own templates works exactly like calling
another of your own tags in a different directory -- an aliased import, a
`PascalName` function, and an `Input` struct generated from the package
template's own `export interface Input`:

```go
import "myapp/marko_modules/fancy_tags"
// ...
fancy_tags.FancyBadge(w, fancy_tags.FancyBadgeInput{Label: "new"})
```

**Add `marko_modules/` to your `.gitignore`** -- the whole directory, not a
`*.marko.go` glob inside it. Unlike your own templates (where you likely
want the generated Go reviewed and possibly even committed), `marko_modules`
is pure build output derived from someone else's package: whatever tags you
use, and how many files that expands into, changes with your dependencies
and is regenerated from scratch every run.

**After `bun add`-ing a new tag package, re-run `generate`** (or restart
`--watch`) -- watch mode only watches your own template tree, not
`node_modules`, so a freshly installed package's tags won't appear until the
next generate.

## Watch

```sh
marko-go generate --watch \
  --proxy="http://localhost:8090" \
  --cmd="go run -buildvcs=false ." \
  ./ui
```

On every `.marko` change (debounced), `marko-go`:

1. regenerates the whole project — cross-template composition means a change
   to one tag can change the Go emitted for its callers, so partial rebuilds
   would be wrong;
2. kills the previous `--cmd` process *group* and starts a fresh one;
3. waits (up to 10s) for `--proxy`'s app URL to answer;
4. pushes a `reload` event to every browser connected to the proxy.

**Open the proxy URL, not the app's port.** The proxy listens on
`http://localhost:7331` (change with `--proxy-port=<port>`) and is the only
one that serves the live-reload script — it injects a small `EventSource`
snippet before `</body>` of HTML responses. Everything that is not
`text/html` streams straight through untouched.

A template that fails to compile during watch prints its error and leaves the
previously generated `.go` files in place. The watcher keeps running; fix the
template and it rebuilds.

Ctrl-C kills the child process group, closes the proxy, and exits cleanly.

### Flags

| flag | meaning |
| --- | --- |
| `--watch` | stay running and regenerate on change |
| `--cmd=<command>` | shell command to restart after each regenerate |
| `--proxy=<url>` | app URL to reverse-proxy with live reload |
| `--proxy-port=<port>` | proxy listen port (default `7331`) |
| `-h`, `--help` | usage |

## Troubleshooting

**`go build` / `go run` fails with a VCS stamping error.** In a bare-repo git
worktree (and some CI checkouts) Go cannot read the VCS metadata it wants to
stamp into the binary, and fails with something like
`error obtaining VCS status: exit status 128`. Disable the stamping:

```sh
marko-go generate --watch --cmd="go run -buildvcs=false ." ./ui
# or, once, for every Go command in the shell:
export GOFLAGS=-buildvcs=false
```

**The browser does not reload.** Make sure you are on the proxy URL
(`http://localhost:7331`), not the app's own port, and that the page has a
`</body>` — the script is injected there. Check the proxy is reaching the app:
the proxy serves an "upstream unavailable" page (which also self-reloads) when
it cannot connect.

**Port 7331 already in use.** Pass `--proxy-port=<other>`.

## Toolchain pinning

`@marko/compiler` and `@marko/runtime-tags` are pinned to **exact** versions
in `package.json` (no `^`/`~` range), currently `5.42.1` / `6.3.42`.

**Why exact pins.** `codegen/src/transpile.mjs` does not treat the compiled
JS as an arbitrary program -- it asserts exact intrinsic names, import
shapes, and call arities (e.g. `_for_of`'s positional argument list,
`_attrs`'s arity) that are internal implementation details of this specific
compiler/runtime-tags version pair, not a stable public contract. A minor or
patch bump is free to change any of that. Separately, the resume wire format
explored in `notes/fr12-resume-findings.md` -- accessor key minification,
registry-id hashes, the bootstrap script text -- is explicitly a
compiler-version artifact (see that doc's "Risks" #1): a `@marko/runtime-tags`
bump can silently change bytes on the wire with no signal beyond "the compiler
moved". Exact pins are the same mitigation for both problems: nothing changes
under this project's feet without a deliberate, reviewed bump.

**Bump procedure.**

1. Bump the pin in `package.json` (still exact, no range) and run
   `bun install` to settle `bun.lock`.
2. Run `bun test codegen/test/intrinsic-arity.test.mjs`. It compiles a small
   set of probe templates and asserts the exact intrinsic import names and
   call shapes the transpiler depends on -- if the new version changed any of
   them, this fails first and loudest, naming the intrinsic.
3. Run the full suite (`bun test`).
4. Run the oracle/golden-file conformance checks (byte-diff generated Go
   output against the JS renderer, and the checked-in golden `.marko.go`
   fixtures) and regenerate goldens deliberately if the new version changed
   legitimate output (`UPDATE_GOLDENS=1 bun test`, where applicable).
5. Commit the pin bump together with any resulting golden/test changes as one
   change -- never bump the pin silently alongside unrelated work.

## License

MIT
