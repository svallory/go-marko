package marko_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/svallory/go-marko/marko"
	"github.com/svallory/go-marko/runtime"
)

func TestHandler(t *testing.T) {
	render := func(w *runtime.Writer, props struct{ Name string }) {
		w.HTML("<h1>Hello, ")
		w.HTML(runtime.Escape(props.Name))
		w.HTML("</h1>")
	}

	h := marko.Handler(render)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	resp := rec.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want %q", ct, "text/html; charset=utf-8")
	}

	// zero-value T: props.Name is "".
	want := "<h1>Hello, </h1>"
	if got := rec.Body.String(); got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestHandlerFunc(t *testing.T) {
	type props struct{ Name string }

	build := func(w http.ResponseWriter, r *http.Request) props {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "s1"})
		return props{Name: r.URL.Query().Get("name")}
	}
	render := func(w *runtime.Writer, p props) {
		w.HTML("<h1>Hello, ")
		w.HTML(runtime.Escape(p.Name))
		w.HTML("</h1>")
	}

	h := marko.HandlerFunc(build, render)

	req := httptest.NewRequest(http.MethodGet, "/?name=World", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	resp := rec.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want %q", ct, "text/html; charset=utf-8")
	}

	want := "<h1>Hello, World</h1>"
	if got := rec.Body.String(); got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}

	cookies := resp.Cookies()
	if len(cookies) != 1 || cookies[0].Name != "session" || cookies[0].Value != "s1" {
		t.Fatalf("cookies = %v, want one session=s1 cookie set by build", cookies)
	}
}
