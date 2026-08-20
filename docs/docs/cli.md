# CLI

## `marko-go generate <dir>`

```sh
marko-go generate ./ui
```

Walks `<dir>` for `**/*.marko`, compiles each one, and writes
`<name>.marko.go` next to the source. Requires a `go.mod` at or above
`<dir>` — its module path is what lets one generated package import
another. Add `*.marko.go` to `.gitignore`; the files are build output.

One-shot mode collects errors across the whole project rather than stopping
at the first failure — each is reported with the source `.marko` path — and
exits non-zero if any template failed.

## Watch mode: the templ-parity dev loop

```sh
marko-go generate --watch \
  --proxy="http://localhost:8090" \
  --cmd="go run -buildvcs=false ." \
  ./ui
```

On every `.marko` change (debounced):

1. Regenerates the whole project — cross-template composition means a
   change to one tag can change the Go emitted for its callers, so partial
   rebuilds would be wrong.
2. Kills the previous `--cmd` process group and starts a fresh one.
3. Waits (up to 10s) for `--proxy`'s app URL to answer.
4. Pushes a reload event to every browser connected to the proxy.

**Open the proxy URL, not the app's port.** The proxy listens on
`http://localhost:7331` by default and is the only thing that serves the
live-reload script — it injects a small `EventSource` snippet before
`</body>` of HTML responses. Everything that isn't `text/html` streams
through untouched.

A template that fails to compile during watch prints its error and leaves
the previously generated `.go` files in place; the watcher keeps running.

Ctrl-C kills the child process group, closes the proxy, and exits cleanly.

## Flags

| flag | meaning |
| --- | --- |
| `--watch` | stay running; regenerate on every `.marko` change |
| `--cmd=<command>` | with `--watch`: shell command to (re)start after each regenerate |
| `--proxy=<url>` | with `--watch`: app URL to reverse-proxy with live reload |
| `--proxy-port=<port>` | proxy listen port (default `7331`) |
| `--client-dir=<dir>` | where page client bundles are written (default `<dir>/.marko-go/client`) |
| `--client-url=<base>` | URL base the generated `<script src>` uses (default `/.marko-go/client/`) |
| `--no-client` | skip the browser half entirely: no bundles, no script tag. A page renders and serves normally but never hydrates |
| `-h`, `--help` | usage |

`--cmd` and `--proxy` only apply with `--watch`. `--client-dir` and
`--client-url` conflict with `--no-client`.

## Requires bun

`marko-go` re-execs itself under `bun` on every invocation, transparently,
even if it was installed with npm/pnpm/yarn and launched under `node`.
Client bundling uses `Bun.build`, which only exists in the bun runtime. If
`bun` isn't on `PATH`, the run fails immediately:

```
marko-go: requires bun for client bundling -- install from https://bun.sh
```

Install bun from [bun.sh](https://bun.sh) and it works regardless of which
package manager installed `marko-go` itself.

## `-buildvcs=false` for bare-repo worktrees

In a bare-repo git worktree (and some CI checkouts), `go build`/`go run`
can fail with something like `error obtaining VCS status: exit status 128`
because Go can't read the VCS metadata it wants to stamp into the binary.
Disable the stamping:

```sh
marko-go generate --watch --cmd="go run -buildvcs=false ." ./ui
```

or, once, for every Go command in the shell:

```sh
export GOFLAGS=-buildvcs=false
```

## Troubleshooting

**Browser doesn't reload.** Confirm you're on the proxy URL
(`http://localhost:7331`), not the app's own port, and that the page has a
`</body>` — the reload script is injected there. The proxy serves an
"upstream unavailable" page (which also self-reloads) when it can't reach
the app.

**Port 7331 already in use.** Pass `--proxy-port=<other>`.
