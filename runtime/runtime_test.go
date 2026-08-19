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

// event mirrors a nested Input struct generated from an inline TS object
// type (`events: { label: string; count: number }[]` -> CounterInputEvents):
// the case typed loops exist for, where the callback needs a concrete struct
// so `item.Label` resolves as a field.
type event struct {
	Label string
	Count float64
}

func TestForOf(t *testing.T) {
	t.Run("typed string slice yields concrete strings", func(t *testing.T) {
		w := New()
		ForOf([]string{"a", "b", "c"}, func(item string) {
			w.HTML("<li>")
			w.HTML(Escape(item))
			w.HTML("</li>")
		})
		if got, want := w.String(), "<li>a</li><li>b</li><li>c</li>"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("slice of structs yields concrete structs", func(t *testing.T) {
		w := New()
		ForOf([]event{{Label: "you clicked", Count: 1}, {Label: "someone", Count: 4}}, func(item event) {
			// Field access, not a type assertion -- the whole point.
			w.HTML(Escape(item.Label))
			w.HTML("=")
			w.HTML(Escape(item.Count))
			w.HTML(" ")
		})
		if got, want := w.String(), "you clicked=1 someone=4 "; got != want {
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

	t.Run("nil typed slice is a no-op", func(t *testing.T) {
		var items []string
		called := false
		ForOf(items, func(item string) { called = true })
		if called {
			t.Error("fn should not be called for a nil typed slice")
		}
	})

	t.Run("empty slice is a no-op", func(t *testing.T) {
		called := false
		ForOf([]string{}, func(item string) { called = true })
		if called {
			t.Error("fn should not be called for an empty slice")
		}
	})
}

func TestForOfIndexed(t *testing.T) {
	t.Run("typed slice with index", func(t *testing.T) {
		w := New()
		ForOfIndexed([]string{"a", "b", "c"}, func(item string, i int) {
			w.HTML(Escape(i))
			w.HTML(":")
			w.HTML(Escape(item))
			w.HTML(" ")
		})
		if got, want := w.String(), "0:a 1:b 2:c "; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("index drives a first-item class, as in the counter page", func(t *testing.T) {
		w := New()
		ForOfIndexed([]event{{Label: "a"}, {Label: "b"}}, func(item event, i int) {
			w.HTML(AttrClass([]any{"row", And(i == 0, "first")}))
		})
		if got, want := w.String(), ` class="row first" class=row`; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("nil typed slice is a no-op", func(t *testing.T) {
		var items []event
		called := false
		ForOfIndexed(items, func(item event, i int) { called = true })
		if called {
			t.Error("fn should not be called for a nil typed slice")
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

func TestForOfAny(t *testing.T) {
	t.Run("walks a typed slice reflectively", func(t *testing.T) {
		w := New()
		ForOfAny([]string{"a", "b", "c"}, func(item any) {
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
		ForOfAny([]any{"a & b", 1, true}, func(item any) {
			w.HTML(Escape(item))
			w.HTML(" ")
		})
		if got, want := w.String(), "a &amp; b 1 true "; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("nil is a no-op", func(t *testing.T) {
		called := false
		ForOfAny(nil, func(item any) { called = true })
		if called {
			t.Error("fn should not be called for nil items")
		}
	})

	t.Run("nil typed slice is a no-op", func(t *testing.T) {
		var items []string
		called := false
		ForOfAny(items, func(item any) { called = true })
		if called {
			t.Error("fn should not be called for a nil typed slice")
		}
	})

	t.Run("empty slice is a no-op", func(t *testing.T) {
		called := false
		ForOfAny([]string{}, func(item any) { called = true })
		if called {
			t.Error("fn should not be called for an empty slice")
		}
	})

	t.Run("non-slice value is a no-op", func(t *testing.T) {
		// JS semantics: iterating a non-array (e.g. a plain number or
		// string) renders nothing rather than panicking.
		called := false
		ForOfAny(42, func(item any) { called = true })
		if called {
			t.Error("fn should not be called for a non-slice value")
		}
	})

	t.Run("array type iterates", func(t *testing.T) {
		w := New()
		ForOfAny([3]int{1, 2, 3}, func(item any) {
			w.HTML(Escape(item))
		})
		if got, want := w.String(), "123"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("struct elements arrive boxed, needing an assertion", func(t *testing.T) {
		w := New()
		ForOfAny([]event{{Label: "x"}}, func(item any) {
			w.HTML(Escape(item.(event).Label))
		})
		if got, want := w.String(), "x"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})
}

func TestForOfIndexedAny(t *testing.T) {
	t.Run("typed slice with index", func(t *testing.T) {
		w := New()
		ForOfIndexedAny([]string{"a", "b"}, func(item any, i int) {
			w.HTML(Escape(i))
			w.HTML(":")
			w.HTML(Escape(item))
			w.HTML(" ")
		})
		if got, want := w.String(), "0:a 1:b "; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("nil is a no-op", func(t *testing.T) {
		called := false
		ForOfIndexedAny(nil, func(item any, i int) { called = true })
		if called {
			t.Error("fn should not be called for nil items")
		}
	})

	t.Run("non-slice value is a no-op", func(t *testing.T) {
		called := false
		ForOfIndexedAny("abc", func(item any, i int) { called = true })
		if called {
			t.Error("fn should not be called for a non-slice value")
		}
	})

	t.Run("array type iterates with indices", func(t *testing.T) {
		w := New()
		ForOfIndexedAny([2]string{"x", "y"}, func(item any, i int) {
			w.HTML(Escape(i))
			w.HTML(Escape(item))
		})
		if got, want := w.String(), "0x1y"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})
}

type testGlobals struct{ Path string }

// TestWriterGlobals covers the FR10 plumbing: generated code reads the
// request context off the Writer with a COMMA-OK assertion, so every
// "globals were never set" path has to yield a usable zero value rather
// than panicking.
func TestWriterGlobals(t *testing.T) {
	t.Run("a fresh Writer has no globals", func(t *testing.T) {
		w := New()
		if got := w.Globals(); got != nil {
			t.Fatalf("Globals() = %#v, want nil", got)
		}
	})

	t.Run("SetGlobals round-trips the value", func(t *testing.T) {
		w := New()
		w.SetGlobals(testGlobals{Path: "/counter"})
		g, ok := w.Globals().(testGlobals)
		if !ok || g.Path != "/counter" {
			t.Fatalf("Globals() = %#v, %v; want testGlobals{/counter}, true", g, ok)
		}
	})

	// The two shapes generated code must survive. This is exactly the
	// `markoGlobal, _ := w.Globals().(ui.Globals)` line it emits.
	t.Run("an unset context asserts to the zero value, not a panic", func(t *testing.T) {
		w := New()
		g, _ := w.Globals().(testGlobals)
		if g.Path != "" {
			t.Fatalf("zero-value globals = %#v, want empty Path", g)
		}
	})

	t.Run("globals of the wrong type assert to the zero value", func(t *testing.T) {
		w := New()
		w.SetGlobals("not the globals struct")
		g, ok := w.Globals().(testGlobals)
		if ok || g.Path != "" {
			t.Fatalf("mistyped globals = %#v, %v; want zero value, false", g, ok)
		}
	})
}
