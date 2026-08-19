package marko

import (
	"net/http"
	"strings"
)

// ClientAssets serves the browser bundles marko-go generate wrote into `dir`
// (by default `<generate-root>/.marko-go/client`).
//
// A page with client-side reactivity emits
// `<script type="module" src="/.marko-go/client/<page>.js">` after its resume
// payload; this is what answers that request. Mount it under the same URL base
// the generator used (`--client-url`, default `/.marko-go/client/`):
//
//	mux.Handle("GET /.marko-go/client/",
//		http.StripPrefix("/.marko-go/client/",
//			marko.ClientAssets("ui/.marko-go/client")))
//
// It is deliberately thin -- an http.FileServer restricted to `.js`, plus the
// two headers a bundle needs:
//
//   - `Content-Type: text/javascript` so the browser will execute a module.
//   - `Cache-Control: no-store`, because a bundle's contents are tied to the
//     registry ids in the page that references it. A cached bundle from a
//     previous build registers setup closures under ids the current payload no
//     longer uses, and the page renders perfectly while being completely
//     inert -- the hardest failure mode here to diagnose. Serving these from a
//     CDN needs content-hashed file names first; see the Phase C report.
//
// Directory listings are refused, and so is anything that is not a `.js` file,
// so pointing this at a directory that also holds other things cannot leak
// them.
func ClientAssets(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, ".js") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fs.ServeHTTP(w, r)
	})
}
