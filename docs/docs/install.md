# Install

## Prerequisites

- **Go 1.24+**
- **[Bun](https://bun.sh)** — required. `marko-go` re-execs itself under
  `bun` even if you installed it with npm/pnpm/yarn, because client bundling
  uses `Bun.build`, which only exists inside the bun runtime. If `bun` isn't
  on `PATH`, `marko-go generate` fails immediately with a clear error.
- **[Task](https://taskfile.dev)** — optional. The quickstart's `Taskfile.yml`
  wraps the common commands (`task dev`, `task build`), but nothing requires
  Task specifically; run the underlying commands directly if you'd rather not
  install it.

> **Naming.** The CLI and npm package are `marko-go`; the Go module is
> `go-marko`. Host language first in each ecosystem's name: npm gets
> `marko-go`, Go gets `go-marko`.

## Install the CLI

```sh
bun add -g marko-go
```

npm/pnpm/yarn work too (`npm i -g marko-go`, `npx marko-go`) — Node >= 20.19
is required to run the CLI at all, but `bun` still has to be on `PATH` for
client bundling regardless of which package manager installed it.

Verify:

```sh
marko-go --help
```

## Add the Go module

```sh
go get github.com/svallory/go-marko
```

This gives you:

- `github.com/svallory/go-marko/runtime` — the runtime package generated
  code calls into (`runtime.Writer`, escaping, resume markers). You won't
  usually import this directly.
- `github.com/svallory/go-marko/marko` — the HTTP helper package
  (`Handler`, `HandlerFunc`, `WithGlobals`, `MountClientAssets`). See
  [HTTP](./http.md).

## Fastest path: the quickstart

Rather than wiring a project up by hand, clone the ready-to-run quickstart
and adapt it — see [Getting started](./getting-started.md).
