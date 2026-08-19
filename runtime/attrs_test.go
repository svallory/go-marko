package runtime

import "testing"

// Expected values in this file were verified against the real
// @marko/runtime-tags HTML runtime (dist/debug/html.js) via node -e,
// calling _attr, _attr_class, _attr_style, and _attrs directly. See
// attrs.go's doc comments for the ported source.

func TestEscapeAttr(t *testing.T) {
	cases := []struct {
		name string
		val  any
		want string
	}{
		{"plain", "hello", "hello"},
		{"double quote", `a"b`, "a&#34;b"},
		{"carriage return", "a\rb", "a&#13;b"},
		{"amp followed by letter", "a&b", "a&amp;b"},
		{"amp followed by hash", "a&#65;", "a&amp;#65;"},
		{"amp followed by digit not entity-like", "a&1b", "a&1b"},
		{"amp followed by space", "a& b", "a& b"},
		{"single quote untouched", "a'b", "a'b"},
		{"less-than untouched", "a<b", "a<b"},
		{"number", 0, "0"},
		{"bool true", true, "true"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := EscapeAttr(c.val); got != c.want {
				t.Errorf("EscapeAttr(%#v) = %q, want %q", c.val, got, c.want)
			}
		})
	}
}

func TestAttr(t *testing.T) {
	cases := []struct {
		name string
		attr string
		val  any
		want string
	}{
		{"nil omitted", "data-x", nil, ""},
		{"false omitted", "data-x", false, ""},
		{"true is bare boolean attr", "data-x", true, " data-x"},
		{"empty string is bare (not omitted)", "data-x", "", " data-x"},
		{"zero int is NOT omitted, unquoted", "data-x", 0, " data-x=0"},
		{"zero float is NOT omitted, unquoted", "data-x", 0.0, " data-x=0"},
		{"positive int unquoted", "data-x", 42, " data-x=42"},
		{"plain string unquoted (no special chars)", "data-x", "plain", " data-x=plain"},
		{"string with double quote uses single-quoting", "data-x", `a"b`, ` data-x='a"b'`},
		{"string with single quote uses double-quoting", "data-x", "a'b", ` data-x="a'b"`},
		{"string with space uses double-quoting", "data-x", "a b", ` data-x="a b"`},
		{"string with both quote kinds: double wins first -> single-quote wrapper", "data-x", `'"both`, ` data-x="'&#34;both"`},
		{"string with both quote kinds: single first -> double-quote wrapper", "data-x", `"'both2`, ` data-x='"&#39;both2'`},
		{"string with amp entity-like escapes inside double-quote wrapper", "data-x", "a&amp b", ` data-x="a&amp;amp b"`},
		{"string with amp non-entity-like stays unquoted", "data-x", "a&1b", " data-x=a&1b"},
		{"string with trailing slash is quoted", "data-x", "a/", ` data-x="a/"`},
		{"string with greater-than is quoted", "data-x", "a>b", ` data-x="a>b"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Attr(c.attr, c.val); got != c.want {
				t.Errorf("Attr(%q, %#v) = %q, want %q", c.attr, c.val, got, c.want)
			}
		})
	}
}

func TestAttrClass(t *testing.T) {
	cases := []struct {
		name string
		val  any
		want string
	}{
		{"nil", nil, ""},
		{"false", false, ""},
		{"empty string", "", ""},
		{"plain string", "foo bar", ` class="foo bar"`},
		{"array with falsy entries skipped", []any{"a", false, "b", nil, "", "c"}, ` class="a b c"`},
		{"array all falsy", []any{false, nil, ""}, ""},
		{"nested array flattens with space", []any{"a", []any{"b", "c"}}, ` class="a b c"`},
		{"map: truthy keys included", map[string]any{"active": true, "disabled": false}, " class=active"},
		{"map: truthy numeric value included by key", map[string]any{"one": 1, "zero": 0}, " class=one"},
		{"empty map", map[string]any{}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := AttrClass(c.val); got != c.want {
				t.Errorf("AttrClass(%#v) = %q, want %q", c.val, got, c.want)
			}
		})
	}
}

func TestAttrStyle(t *testing.T) {
	cases := []struct {
		name string
		val  any
		want string
	}{
		{"nil", nil, ""},
		{"false", false, ""},
		{"empty string", "", ""},
		{"plain string unquoted (no special chars)", "color:red", " style=color:red"},
		{"array joins with semicolon, falsy skipped", []any{"color:red", false, "top:1px"}, " style=color:red;top:1px"},
		{"map single truthy entry unquoted", map[string]any{"color": "red"}, " style=color:red"},
		{"map: zero value IS included (0 special-cased like text Escape)", map[string]any{"width": 0}, " style=width:0"},
		{"map: false value excluded", map[string]any{"height": false}, ""},
		{"map: empty string value excluded", map[string]any{"color": ""}, ""},
		{"value needing escape gets quoted", map[string]any{"top": "1px;2px"}, ` style="top:1px\3B 2px"`},
		{"empty map", map[string]any{}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := AttrStyle(c.val); got != c.want {
				t.Errorf("AttrStyle(%#v) = %q, want %q", c.val, got, c.want)
			}
		})
	}
}

func TestAttrs(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		if got := Attrs(); got != "" {
			t.Errorf("Attrs() = %q, want \"\"", got)
		}
	})

	t.Run("ordered A items render in order", func(t *testing.T) {
		got := Attrs(A{"href", "/x"}, A{"id", "y"})
		want := ` href=/x id=y`
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("class and style route through AttrClass/AttrStyle", func(t *testing.T) {
		got := Attrs(A{"class", []any{"a", "b"}}, A{"style", map[string]any{"color": "red"}})
		want := ` class="a b" style=color:red`
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("void values omitted", func(t *testing.T) {
		got := Attrs(A{"disabled", false}, A{"hidden", nil}, A{"checked", true})
		want := " checked"
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("event-handler-ish keys dropped", func(t *testing.T) {
		got := Attrs(A{"onClick", "shouldBeDropped"}, A{"id", "y"})
		want := " id=y"
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("spread map merges with later-wins override, first-set position kept", func(t *testing.T) {
		// Mirrors JS: {a:1,b:2} then spread {b:3,c:4} then spread {a:5}
		// => {a:5,b:3,c:4} (a and b keep their original slots; c appended).
		got := Attrs(
			A{"a", 1}, A{"b", 2},
			map[string]any{"b": 3, "c": 4},
			map[string]any{"a": 5},
		)
		want := " a=5 b=3 c=4"
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("spread overrides an earlier A item", func(t *testing.T) {
		got := Attrs(A{"id", "old"}, map[string]any{"id": "new"})
		want := " id=new"
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("A item after spread overrides but keeps spread's position", func(t *testing.T) {
		// A map[string]any spread has no defined iteration order in Go
		// (unlike JS object literals, which preserve insertion order), so
		// when a single spread introduces multiple keys, this port visits
		// them in sorted-key order -- here "class" sorts before "id", so
		// class claims the earlier position. This is a documented
		// deviation from JS object-spread position semantics; the
		// override *value* (id=second) still wins, which is the part that
		// matters for correctness.
		got := Attrs(map[string]any{"id": "first", "class": "c"}, A{"id", "second"})
		want := " class=c id=second"
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("single spread map: keys sorted for determinism", func(t *testing.T) {
		got := Attrs(map[string]any{"zeta": "1", "alpha": "2", "mid": "3"})
		want := " alpha=2 mid=3 zeta=1"
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	t.Run("mixed A and spread, class from spread", func(t *testing.T) {
		got := Attrs(
			A{"href", "/x"},
			map[string]any{"class": []any{"a", false, "b"}},
			A{"data-id", 3},
		)
		want := ` href=/x class="a b" data-id=3`
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})
}
