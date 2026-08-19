package marko

import (
	"net/http"

	"github.com/svallory/go-marko/runtime"
)

// Option configures a handler built by Handler or HandlerFunc. The type is
// opaque: construct one with WithGlobals.
type Option func(*config)

type config struct {
	buildGlobals func(*http.Request) any
}

func newConfig(opts []Option) config {
	var c config
	for _, opt := range opts {
		opt(&c)
	}
	return c
}

// apply sets up the writer for one request according to the configuration.
func (c config) apply(w *runtime.Writer, r *http.Request) {
	if c.buildGlobals != nil {
		w.SetGlobals(c.buildGlobals(r))
	}
}

// WithGlobals supplies the request-scoped globals ($global in Marko) for
// every request the handler serves. `build` is called once per request,
// before the template renders, and its result is attached to the
// runtime.Writer.
//
// G is normally the Globals struct marko-go generates from the
// `Marko.Global` interface declared in the project's `global.d.ts` (package
// `ui` by convention). The generated template code reads it with a comma-ok
// type assertion, so the type here must match the generated one exactly; a
// mismatch renders zero-value globals rather than panicking.
//
// Example:
//
//	mux.Handle("GET /", marko.Handler(pages.Landing,
//		marko.WithGlobals(func(r *http.Request) ui.Globals {
//			return ui.Globals{Path: r.URL.Path}
//		}),
//	))
//
// Handlers built without this option render with zero-value globals, which
// is also what a direct `pages.Landing(w, input)` call gets.
func WithGlobals[G any](build func(*http.Request) G) Option {
	return func(c *config) {
		c.buildGlobals = func(r *http.Request) any { return build(r) }
	}
}
