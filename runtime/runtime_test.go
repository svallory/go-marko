package runtime

import "testing"

func TestEscape(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"nil", nil, ""},
		{"empty string", "", ""},
		{"false", false, ""},
		{"zero int", 0, "0"},
		{"zero float", 0.0, "0"},
		{"plain string", "hello", "hello"},
		{"ampersand", "a & b", "a &amp; b"},
		{"lt", "1 < 2", "1 &lt; 2"},
		{"cr", "a\rb", "a&#13;b"},
		{"gt is not escaped in text content", "a > b", "a > b"},
		{"quotes are not escaped in text content", `he said "hi"`, `he said "hi"`},
		{"int", 42, "42"},
		{"bool true", true, "true"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Escape(c.in); got != c.want {
				t.Errorf("Escape(%#v) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestWriterHTML(t *testing.T) {
	w := New()
	w.HTML("<div>")
	w.HTML(Escape("a & b"))
	w.HTML("</div>")
	if got, want := w.String(), "<div>a &amp; b</div>"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestForOf(t *testing.T) {
	t.Run("typed string slice", func(t *testing.T) {
		w := New()
		ForOf([]string{"a", "b", "c"}, func(item any) {
			w.HTML("<li>")
			w.HTML(Escape(item))
			w.HTML("</li>")
		})
		if got, want := w.String(), "<li>a</li><li>b</li><li>c</li>"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("[]any slice", func(t *testing.T) {
		w := New()
		ForOf([]any{"a & b", 1, true}, func(item any) {
			w.HTML("<li>")
			w.HTML(Escape(item))
			w.HTML("</li>")
		})
		if got, want := w.String(), "<li>a &amp; b</li><li>1</li><li>true</li>"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("nil is a no-op", func(t *testing.T) {
		w := New()
		called := false
		ForOf(nil, func(item any) { called = true })
		if called {
			t.Error("fn should not be called for nil items")
		}
		if got := w.String(); got != "" {
			t.Errorf("got %q, want empty", got)
		}
	})

	t.Run("nil typed slice is a no-op", func(t *testing.T) {
		var items []string
		called := false
		ForOf(items, func(item any) { called = true })
		if called {
			t.Error("fn should not be called for a nil typed slice")
		}
	})

	t.Run("empty slice is a no-op", func(t *testing.T) {
		called := false
		ForOf([]string{}, func(item any) { called = true })
		if called {
			t.Error("fn should not be called for an empty slice")
		}
	})

	t.Run("non-slice value is a no-op", func(t *testing.T) {
		// JS semantics: iterating a non-array (e.g. a plain number or
		// string) renders nothing rather than panicking.
		called := false
		ForOf(42, func(item any) { called = true })
		if called {
			t.Error("fn should not be called for a non-slice value")
		}
	})

	t.Run("array type iterates", func(t *testing.T) {
		w := New()
		ForOf([3]int{1, 2, 3}, func(item any) {
			w.HTML(Escape(item))
		})
		if got, want := w.String(), "123"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})
}

func TestForOfIndexed(t *testing.T) {
	t.Run("typed slice with index", func(t *testing.T) {
		w := New()
		ForOfIndexed([]string{"a", "b", "c"}, func(item any, i int) {
			w.HTML(Escape(i))
			w.HTML(":")
			w.HTML(Escape(item))
			w.HTML(" ")
		})
		if got, want := w.String(), "0:a 1:b 2:c "; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("nil is a no-op", func(t *testing.T) {
		called := false
		ForOfIndexed(nil, func(item any, i int) { called = true })
		if called {
			t.Error("fn should not be called for nil items")
		}
	})

	t.Run("empty slice is a no-op", func(t *testing.T) {
		called := false
		ForOfIndexed([]any{}, func(item any, i int) { called = true })
		if called {
			t.Error("fn should not be called for an empty slice")
		}
	})
}
