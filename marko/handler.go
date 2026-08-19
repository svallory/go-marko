// Package marko adapts marko-go render functions to net/http. It mirrors the
// developer experience of templ's http.Handler helpers: wrap a generated
// render function and get back a ready-to-mount http.Handler.
package marko

import (
	"net/http"

	"github.com/svallory/go-marko/runtime"
)

// Handler wraps a render function generated from a .marko template into an
// http.Handler. The input value passed to render is always the zero value of
// T; use HandlerFunc when the render input must be built from the incoming
// request.
//
// The handler renders into a fresh runtime.Writer, sets the response
// Content-Type to "text/html; charset=utf-8", and writes the resulting HTML.
// Rendering is synchronous and unbuffered to the client: no streaming.
//
// Example:
//
//	mux := http.NewServeMux()
//	mux.Handle("GET /", marko.Handler(pages.Landing))
func Handler[T any](render func(*runtime.Writer, T)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input T
		writer := runtime.New()
		render(writer, input)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(writer.String()))
	})
}

// HandlerFunc wraps a render function together with a build function that
// constructs the render input from the incoming request. Use this when the
// template needs data derived from the request, such as path values, query
// parameters, or headers.
//
// build also receives the http.ResponseWriter so it can set response headers
// or cookies (e.g. minting a session cookie on first visit) before the page
// is rendered. It must not write the response body or call WriteHeader; the
// handler writes the rendered HTML after build returns.
//
// Like Handler, it renders into a fresh runtime.Writer, sets the response
// Content-Type to "text/html; charset=utf-8", and writes the resulting HTML.
//
// Example:
//
//	mux := http.NewServeMux()
//	mux.Handle("GET /users/{id}", marko.HandlerFunc(
//		func(w http.ResponseWriter, r *http.Request) pages.UserProps {
//			return pages.UserProps{ID: r.PathValue("id")}
//		},
//		pages.User,
//	))
func HandlerFunc[T any](build func(http.ResponseWriter, *http.Request) T, render func(*runtime.Writer, T)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		input := build(w, r)
		writer := runtime.New()
		render(writer, input)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(writer.String()))
	})
}
