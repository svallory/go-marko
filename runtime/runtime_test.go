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
	w := New()
	ForOf([]string{"a", "b", "c"}, func(item string) {
		w.HTML("<li>")
		w.HTML(Escape(item))
		w.HTML("</li>")
	})
	if got, want := w.String(), "<li>a</li><li>b</li><li>c</li>"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
