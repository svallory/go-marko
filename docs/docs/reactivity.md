# Reactivity

This is the flagship feature: client-side state that updates in the browser
— no hand-written JavaScript, no SPA framework — served entirely from a Go
backend.

## The counter

```marko
// ui/pages/reactive.marko
export interface Input {}

<page-layout title="Reactive — go-marko Quickstart">
  <let/count=0>

  <div class="text-6xl font-bold tabular-nums">${count}</div>

  <div class="flex gap-3">
    <button onClick() { count++ }>
      Increment
    </button>
    <button
      disabled=(count === 0)
      onClick() { count = 0 }
    >
      Reset
    </button>
  </div>
</page-layout>
```

`<let/count=0>` declares client-observable state. `onClick() { count++ }` is
a real event handler that runs in the browser and mutates that state — the
button click, the counter increment, and the `disabled` re-evaluation all
happen client-side, with no round trip to the server.

## How it's served

1. **`marko-go generate`** compiles `reactive.marko` to
   `reactive.marko.go` as usual, but because the page contains reactive
   state, it *also* emits a per-page client JavaScript bundle to
   `ui/.marko-go/client/pages-reactive.js`.
2. The generated Go for the page includes a bundle reference
   (`w.ClientBundle("/.marko-go/client/pages-reactive.js")`) and emits a
   `<script type="module" src="...">` tag pointing at it, plus resume
   markers around the reactive parts of the HTML so the client bundle knows
   which DOM nodes it owns.
3. On the Go server, mount the bundle directory once:

   ```go
   mux := http.NewServeMux()
   marko.MountClientAssets(mux, "ui/.marko-go/client")
   ```

   This serves whatever `marko-go generate` wrote, at the URL prefix the
   generated `<script src>` tags already point to
   (`/.marko-go/client/` by default) — no `http.StripPrefix` wiring needed.

**Pages with no reactivity ship no bundle and no script tag at all.** The
landing page and counter page in the quickstart (state lives server-side,
updated via form POST) are ordinary server-rendered HTML — zero client
JavaScript, nothing to mount for them.

## Current scope

This is wave 1. Supported today:

- Flat scalar state via `<let>` on **native HTML tags** (`<div>`, `<button>`,
  etc.) — a `<let>` binding read and written by `onClick` (and similar
  native DOM event handlers) on plain elements.

Not yet supported — treat these as roadmap, not present behavior:

- Reactive `<if>` / `<for>` (conditionally showing/hiding or looping over
  client state).
- Event handlers passed through custom tags (a handler defined on a page
  but attached to a `<button>` inside a custom tag it renders).

If a template needs more than flat scalar state on native tags, it's not
supported yet — check back as the reactivity surface grows.
