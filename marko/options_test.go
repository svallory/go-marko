package marko_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/svallory/go-marko/marko"
	"github.com/svallory/go-marko/runtime"
)

// uiGlobals stands in for the `ui.Globals` struct marko-go generates from a
// project's `Marko.Global` declaration.
type uiGlobals struct{ Path string }

// renderGlobals is shaped like generated template code: it reads the
// request context off the Writer with a comma-ok assertion, so a render with
// no globals configured falls back to the zero value.
func renderGlobals(w *runtime.Writer, _ struct{}) {
	g, _ := w.Globals().(uiGlobals)
	w.HTML("<p>")
	w.HTML(runtime.Escape(g.Path))
	w.HTML("</p>")
}

func serve(t *testing.T, h http.Handler, target string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec.Body.String()
}

func TestHandlerWithGlobals(t *testing.T) {
	h := marko.Handler(renderGlobals, marko.WithGlobals(func(r *http.Request) uiGlobals {
		return uiGlobals{Path: r.URL.Path}
	}))

	if got, want := serve(t, h, "/counter"), "<p>/counter</p>"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

// Without the option the template still renders -- with zero-value globals.
// That's the "plain render(w, input) keeps working" contract.
func TestHandlerWithoutGlobalsRendersZeroValue(t *testing.T) {
	h := marko.Handler(renderGlobals)

	if got, want := serve(t, h, "/counter"), "<p></p>"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestHandlerFuncWithGlobals(t *testing.T) {
	type props struct{ Name string }

	build := func(w http.ResponseWriter, r *http.Request) props {
		// The ResponseWriter arm of build still works alongside options.
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "s1"})
		return props{Name: r.URL.Query().Get("name")}
	}
	render := func(w *runtime.Writer, p props) {
		g, _ := w.Globals().(uiGlobals)
		w.HTML(runtime.Escape(p.Name))
		w.HTML("@")
		w.HTML(runtime.Escape(g.Path))
	}

	h := marko.HandlerFunc(build, render, marko.WithGlobals(func(r *http.Request) uiGlobals {
		return uiGlobals{Path: r.URL.Path}
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/counter?name=World", nil))

	if got, want := rec.Body.String(), "World@/counter"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "session" {
		t.Fatalf("cookies = %v, want the session cookie build sets", cookies)
	}
}

// Globals are built PER REQUEST, not once when the handler is constructed.
func TestWithGlobalsIsPerRequest(t *testing.T) {
	calls := 0
	h := marko.Handler(renderGlobals, marko.WithGlobals(func(r *http.Request) uiGlobals {
		calls++
		return uiGlobals{Path: r.URL.Path}
	}))

	if got := serve(t, h, "/a"); got != "<p>/a</p>" {
		t.Fatalf("first request body = %q", got)
	}
	if got := serve(t, h, "/b"); got != "<p>/b</p>" {
		t.Fatalf("second request body = %q", got)
	}
	if calls != 2 {
		t.Fatalf("build called %d times, want once per request", calls)
	}
}

// A later option wins, so a handler can be composed from a shared slice of
// defaults plus a per-route override.
func TestLastGlobalsOptionWins(t *testing.T) {
	h := marko.Handler(renderGlobals,
		marko.WithGlobals(func(*http.Request) uiGlobals { return uiGlobals{Path: "first"} }),
		marko.WithGlobals(func(*http.Request) uiGlobals { return uiGlobals{Path: "second"} }),
	)

	if got, want := serve(t, h, "/x"), "<p>second</p>"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}
