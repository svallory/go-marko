package marko

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestClientAssets(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "page.js"), []byte("export{};"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("GET /.marko-go/client/",
		http.StripPrefix("/.marko-go/client/", ClientAssets(dir)))

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec
	}

	t.Run("serves a bundle with the headers a module needs", func(t *testing.T) {
		rec := get("/.marko-go/client/page.js")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if rec.Body.String() != "export{};" {
			t.Fatalf("body = %q", rec.Body.String())
		}
		// Without text/javascript the browser refuses to execute the module.
		if ct := rec.Header().Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
			t.Fatalf("Content-Type = %q", ct)
		}
		// A cached bundle from a previous build registers setup closures under
		// registry ids the current payload no longer uses: the page renders
		// perfectly and is completely inert. Hence no-store.
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Fatalf("Cache-Control = %q", cc)
		}
	})

	t.Run("refuses anything that is not a .js file", func(t *testing.T) {
		// The client dir is served wholesale, so a non-.js file sitting there
		// must not be reachable.
		for _, p := range []string{
			"/.marko-go/client/secret.txt",
			"/.marko-go/client/",
			"/.marko-go/client/missing.js",
		} {
			if rec := get(p); rec.Code != http.StatusNotFound {
				t.Errorf("GET %s status = %d, want 404", p, rec.Code)
			}
		}
	})
}

func TestMountClientAssets(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "page.js"), []byte("export{};"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	MountClientAssets(mux, dir)

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec
	}

	t.Run("serves a bundle at the default prefix with no StripPrefix wiring", func(t *testing.T) {
		rec := get("/.marko-go/client/page.js")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if rec.Body.String() != "export{};" {
			t.Fatalf("body = %q", rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
			t.Fatalf("Content-Type = %q", ct)
		}
	})

	t.Run("still refuses non-.js files and directory listings", func(t *testing.T) {
		for _, p := range []string{
			"/.marko-go/client/secret.txt",
			"/.marko-go/client/",
			"/.marko-go/client/missing.js",
		} {
			if rec := get(p); rec.Code != http.StatusNotFound {
				t.Errorf("GET %s status = %d, want 404", p, rec.Code)
			}
		}
	})
}

func TestMountClientAssetsAt(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "page.js"), []byte("export{};"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("custom prefix without trailing slash is corrected", func(t *testing.T) {
		mux := http.NewServeMux()
		MountClientAssetsAt(mux, "/assets/js", dir)

		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/js/page.js", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if rec.Body.String() != "export{};" {
			t.Fatalf("body = %q", rec.Body.String())
		}
	})

	t.Run("custom prefix with trailing slash works as-is", func(t *testing.T) {
		mux := http.NewServeMux()
		MountClientAssetsAt(mux, "/assets/js/", dir)

		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/js/page.js", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("DefaultClientURLPrefix is the documented convention", func(t *testing.T) {
		if DefaultClientURLPrefix != "/.marko-go/client/" {
			t.Fatalf("DefaultClientURLPrefix = %q", DefaultClientURLPrefix)
		}
	})
}
