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

## License

MIT
