package marko

import (
	"net/http"
	"strings"
)

// DefaultClientURLPrefix is the URL prefix `marko-go generate` embeds into
// every emitted `<script src>` unless the project overrides it with
// `--client-url`. It pairs with the codegen default output directory: the
// bundle written to `<generate-root>/.marko-go/client/<page>.js` is served
// back from `/.marko-go/client/<page>.js`.
//
// "generate-root" means whatever directory you pass as `<dir>` to
// `marko-go generate <dir>` (e.g. `ui` in `marko-go generate ./ui`) -- NOT
// your Go module root. If your generate root and module root differ, the dir
// argument to Mount* below must still be `<generate-root>/.marko-go/client`,
// resolved however you like (`ui/.marko-go/client`, an absolute path, etc).
const DefaultClientURLPrefix = "/.marko-go/client/"

// ClientAssets serves the browser bundles marko-go generate wrote into `dir`
// (by default `<generate-root>/.marko-go/client`).
//
// A page with client-side reactivity emits
// `<script type="module" src="/.marko-go/client/<page>.js">` after its resume
// payload; this is what answers that request. ClientAssets is the low-level
// piece: it does not know what URL prefix it is mounted under, so the caller
// must strip that prefix before the request reaches it (an unstripped request
// path won't match any file in `dir`). Use `http.StripPrefix` directly, or --
// simpler -- call MountClientAssets / MountClientAssetsAt below, which wire
// that up for you.
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

// MountClientAssets registers ClientAssets on mux at the default convention:
// URL prefix `/.marko-go/client/` (DefaultClientURLPrefix) serving `dir`,
// with the http.StripPrefix wiring done for you. This is the one-liner for
// projects that did not pass `--client-url` to `marko-go generate`:
//
//	marko.MountClientAssets(mux, "ui/.marko-go/client")
//
// `dir` must be the directory `marko-go generate` actually wrote bundles
// into -- by default `<generate-root>/.marko-go/client` (see
// DefaultClientURLPrefix for what "generate-root" means), or wherever
// `--client-dir` pointed if the project overrode it.
func MountClientAssets(mux *http.ServeMux, dir string) {
	MountClientAssetsAt(mux, DefaultClientURLPrefix, dir)
}

// MountClientAssetsAt is MountClientAssets for a project that passed a
// custom `--client-url` to `marko-go generate`. urlPrefix must match that
// flag exactly, including the trailing slash:
//
//	marko.MountClientAssetsAt(mux, "/assets/js/", "ui/.marko-go/client")
//
// A urlPrefix without a trailing slash is corrected automatically, since
// http.ServeMux treats `/foo/` (a subtree) and `/foo` (an exact match)
// differently and only the former is useful here.
func MountClientAssetsAt(mux *http.ServeMux, urlPrefix, dir string) {
	if !strings.HasSuffix(urlPrefix, "/") {
		urlPrefix += "/"
	}
	mux.Handle("GET "+urlPrefix, http.StripPrefix(urlPrefix, ClientAssets(dir)))
}
