# Templates

The supported Marko surface, with the smallest example of each. Everything
below is drawn from templates that actually compile through `marko-go
generate` in the quickstart.

## Interpolation and escaping

```marko
<div class="text-6xl font-bold tabular-nums">${count}</div>
```

`${expr}` interpolates into text content, HTML-escaped.

## if / else

```marko
<if=input.events.length>
  <div>...</div>
</if>
<else>
  <p class="text-muted-foreground text-sm">No clicks yet — be the first.</p>
</else>
```

## for

Typed, indexed loop over a slice-typed `Input` field:

```marko
<for|event, i| of=input.events>
  <li class=[
    "flex items-center justify-between px-3 py-1.5 text-sm",
    i === 0 && "bg-accent/50 font-medium",
  ]>
    <span>${event.label}</span>
    <span class="text-muted-foreground tabular-nums">${event.count}</span>
  </li>
</for>
```

`event` and `i` are typed from the slice element type declared on `Input`.

## Custom tags and content (`Marko.Body`)

A tag that accepts a body:

```marko
// page-layout.marko
export interface Input {
  title?: string;
  content: Marko.Body;
}

<html>
  <body>
    <${input.content}/>
  </body>
</html>
```

Callers pass nested markup as the body:

```marko
<page-layout title="go-marko Quickstart">
  <div>...</div>
</page-layout>
```

`Marko.Body` fields generate as a Go closure (`func(w *runtime.Writer)`);
the caller's nested content becomes the closure body.

## Attr tags (`<@head>`)

Named, optional slot content, separate from the main body:

```marko
// page-layout.marko
export interface Input {
  head?: Marko.AttrTag<{ content: Marko.Body }>;
  content: Marko.Body;
}

<head>
  <if=input.head>
    <${input.head.content}/>
  </if>
</head>
```

Callers pass it with `<@name>`:

```marko
<page-layout title="Counter">
  <@head>
    <meta name="description" content="...">
  </@head>
  <div>...</div>
</page-layout>
```

`input.head` is a generated pointer struct (`*PageLayoutInputHead`), `nil`
when the caller doesn't pass `<@head>` — that's what the `<if=input.head>`
guard tests.

## `$global`

Request-scoped values readable from any template, no prop drilling.
Declared once in `global.d.ts`:

```ts
declare global {
  namespace Marko {
    interface Global {
      /** Current request path, e.g. "/counter". */
      path: string;
    }
  }
}
export {};
```

Used in any template:

```marko
<ui-button
  class=($global.path === "/counter" && "bg-accent text-accent-foreground")
>
  Counter
</ui-button>
```

`marko-go generate` turns the `Marko.Global` augmentation into a generated
`Globals` struct (package `ui` by convention, `Globals{ Path string }` for
the example above). Supply it per request on the Go side with
`marko.WithGlobals` — see [HTTP](./http.md). Rendering without it (a direct
`pages.Foo(w, input)` call, or a handler with no `WithGlobals` option) still
works; templates just see the zero-value globals.

## Conditional and spread attributes

```marko
<a href=input.href target=input.target class=classes ...input.attrs>
  <${input.content}/>
</a>
```

- `target=input.target` — an attribute whose value is `false`, `null`, or
  `undefined` renders nothing (the attribute is omitted, not emitted empty).
- `...input.attrs` — spreads a `Marko.HTMLAttributes` map onto the tag;
  each key becomes an attribute, escaped, with the same falsy-omission rule.
- `class=classes` — `class` accepts an array; falsy entries (`false`,
  `undefined`, `""`) are filtered out and the rest joined with spaces.

## Static const

Module-level values computed once, not per render:

```marko
static const variants = {
  default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
  outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
};
```

Per-render computed values use `<const>`:

```marko
<const/classes=[
  base,
  variants[input.variant ?? "default"],
  input.class,
]>
```

## TypeScript types

Every template's `export interface Input { ... }` is TypeScript, type-checked
against `tsconfig.json` at the project root. `marko-go generate` derives the
Go `Input` struct from it:

| TS | Go |
| --- | --- |
| `string` | `string` |
| `number` | `float64` |
| `boolean` | `bool` |
| `T \| undefined` (optional field) | pointer or omitted, per field |
| `"a" \| "b" \| "c"` (string union) | `string` |
| `{ ... }[]` | `[]GeneratedNestedStruct` |
| `Marko.Body` | `func(w *runtime.Writer)` |
| `Marko.HTMLAttributes` | `map[string]any` |
| `Marko.AttrTag<{ content: Marko.Body }>` | pointer to a generated struct with a `Content` closure field |

**`number` → `float64` is JS-faithful, not Go-idiomatic.** If your Go code
holds an `int`, cast it at the `Input` boundary:

```go
return pages.CounterInput{
	Global: float64(globalCount),
	User:   float64(userCounts[id]),
}
```

There's no int/float distinction in the type system yet — living with
`float64` until it's worth adding an override mechanism.

## Client JS via assets + `html-script`

Marko 6 compiles top-level `<script>` blocks into client-effect code for a
browser bundle — there's no way to pass a literal `<script>` body straight
through to the rendered HTML. For plain static page JS (not reactive
state), ship it as a static asset and reference it with the `html-script`
core tag:

```marko
<html-script src="/assets/js/theme.js" defer></html-script>
```

This compiles to a real `<script src="..." defer></script>` in the output —
unlike a bare `<script>` tag, which is a compile error in Marko 6 when it
carries attributes.

For actual client-side *reactivity* (state that changes in the browser
without a page reload), see [Reactivity](./reactivity.md).
