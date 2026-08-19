package runtime

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"
)

// vector is one entry of testdata/vectors.json, produced by driving the real
// @marko/runtime-tags serializer (scratch/resume-wire-study/serialize.mjs).
type vector struct {
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	Scopes          string `json:"scopes"`
	ExpectedPayload string `json:"expectedPayload"`
}

// buildFn stages the scope writes for one vector onto a Writer. The inputs
// are transcribed from serialize.mjs; the expected bytes come from the JSON,
// so the two halves of each vector stay independent.
type buildFn func(w *Writer)

func scope(id int, kv ...any) buildFn {
	return func(w *Writer) { w.AddScope(id, ScopeStateOf(kv...)) }
}

func seq(fns ...buildFn) buildFn {
	return func(w *Writer) {
		for _, fn := range fns {
			fn(w)
		}
	}
}

// vectorInputs maps each serializer vector name to its input structure.
var vectorInputs = map[string]buildFn{
	// --- scalars ---
	"ser/int":      scope(1, "a", 42),
	"ser/zero":     scope(1, "a", 0),
	"ser/negzero":  scope(1, "a", math.Copysign(0, -1)),
	"ser/float":    scope(1, "a", 1.5),
	"ser/negfloat": scope(1, "a", -0.25),
	"ser/bignum":   scope(1, "a", 1e21),
	"ser/smallnum": scope(1, "a", 1e-7),
	"ser/nan":      scope(1, "a", math.NaN()),
	"ser/inf":      scope(1, "a", math.Inf(1)),
	"ser/neginf":   scope(1, "a", math.Inf(-1)),
	"ser/true":     scope(1, "a", true),
	"ser/false":    scope(1, "a", false),
	"ser/null":     scope(1, "a", nil),
	"ser/undef":    scope(1, "a", Undefined, "b", 1),

	// --- strings ---
	"ser/str_short":          scope(1, "a", "hi"),
	"ser/str_12":             scope(1, "a", "123456789012"),
	"ser/str_13":             scope(1, "a", "1234567890123"),
	"ser/str_quote":          scope(1, "a", `he said "hi"`),
	"ser/str_backslash":      scope(1, "a", `a\b`),
	"ser/str_lt":             scope(1, "a", "a<b"),
	"ser/str_script":         scope(1, "a", "</script>"),
	"ser/str_nl":             scope(1, "a", "a\nb\rc"),
	"ser/str_nul":            scope(1, "a", "a\x00b"),
	"ser/str_sep":            scope(1, "a", "a b c"),
	"ser/str_unicode":        scope(1, "a", "héllo wörld ünïcode"),
	"ser/str_emoji":          scope(1, "a", "hi 👋🏽 there"),
	"ser/str_lone_surrogate": scope(1, "a", "a"+loneSurrogate(0xD800)+"b"),
	"ser/str_singlequote":    scope(1, "a", "it's a 'test'"),

	// --- keys ---
	"ser/key_ident":        scope(1, "abc", 1),
	"ser/key_dollar":       scope(1, "$x", 1, "_y", 2),
	"ser/key_numeric":      scope(1, "0", 1, "12", 2),
	"ser/key_leading_zero": scope(1, "01", 1),
	"ser/key_dash":         scope(1, "a-b", 1),
	"ser/key_empty":        scope(1, "", 1),

	// --- containers ---
	"ser/arr_empty": scope(1, "a", []any{}),
	"ser/arr_mixed": scope(1, "a", []any{1, "two", true, nil}),
	"ser/arr_hole":  scope(1, "a", []any{1, Undefined, 3}),
	"ser/obj_empty": scope(1, "a", NewScopeState()),
	"ser/obj_nested": scope(1, "a", ScopeStateOf(
		"b", ScopeStateOf("c", ScopeStateOf("d", 1)))),
	// Scope 1 has no props, so it vanishes and scope 2 becomes the head.
	"ser/obj_empty_scope": seq(scope(1), scope(2, "a", 1)),

	// --- refs / dedup ---
	"ser/shared_obj":       sharedObj(),
	"ser/shared_str":       scope(1, "a", "a string longer than twelve", "b", "a string longer than twelve"),
	"ser/shared_str_short": scope(1, "a", "short", "b", "short"),
	"ser/shared_across_scopes": func(w *Writer) {
		o := ScopeStateOf("v", 1)
		w.AddScope(1, ScopeStateOf("a", o))
		w.AddScope(2, ScopeStateOf("b", o))
	},
	"ser/many_refs": manyRefs(),

	// --- scope ids / deltas ---
	"ser/ids_consecutive": seq(scope(1, "a", 1), scope(2, "a", 2), scope(3, "a", 3)),
	"ser/ids_sparse":      seq(scope(1, "a", 1), scope(5, "a", 2), scope(9, "a", 3)),
	"ser/ids_start_high":  scope(7, "a", 1),
	"ser/ids_gap_one":     seq(scope(1, "a", 1), scope(3, "a", 2)),

	// --- scope refs ---
	"ser/scope_ref_parent":  seq(scope(1, "a", 1), scope(2, "_", Scope(1))),
	"ser/scope_ref_self":    scope(1, "a", 1, "me", Scope(1)),
	"ser/scope_ref_forward": seq(scope(1, "x", Scope(9)), scope(9, "a", 1)),
}

// cyclicVectors are the two vectors whose fixup form is deliberately out of
// scope for wave 1. They must produce a clear error rather than bytes.
var cyclicVectors = map[string]bool{
	"ser/cycle_self":   true,
	"ser/cycle_mutual": true,
}

func sharedObj() buildFn {
	return func(w *Writer) {
		o := ScopeStateOf("v", 1)
		w.AddScope(1, ScopeStateOf("a", o, "b", o))
	}
}

func manyRefs() buildFn {
	return func(w *Writer) {
		state := NewScopeState()
		for i := 0; i < 60; i++ {
			shared := ScopeStateOf("i", i)
			state.Set("k"+strconv.Itoa(i), []any{shared, shared})
		}
		w.AddScope(1, state)
	}
}

// loneSurrogate builds the WTF-8 encoding of an unpaired surrogate, which is
// how a Go string carries what JS holds natively as a lone UTF-16 unit.
func loneSurrogate(cp rune) string {
	return string([]byte{
		byte(0xE0 | (cp >> 12)),
		byte(0x80 | ((cp >> 6) & 0x3F)),
		byte(0x80 | (cp & 0x3F)),
	})
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	data, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vs []vector
	if err := json.Unmarshal(data, &vs); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return vs
}

// payloadOf renders the staged scopes and extracts the `M._.r=[...]` body,
// the same slice serialize.mjs captured from the real runtime.
func payloadOf(t *testing.T, build buildFn) (string, error) {
	t.Helper()
	w := New()
	build(w)
	if err := w.FlushResume(); err != nil {
		return "", err
	}
	out := w.String()
	const open = "M._.r=["
	i := strings.Index(out, open)
	if i < 0 {
		return "", nil
	}
	rest := out[i+len(open):]
	end := strings.LastIndex(rest, "]")
	return rest[:end], nil
}

// TestSerializerVectors is the byte-exactness gate: every kind:"serializer"
// vector must reproduce the exact payload the real Marko runtime produced.
func TestSerializerVectors(t *testing.T) {
	vs := loadVectors(t)
	checked := 0
	for _, v := range vs {
		if v.Kind != "serializer" {
			continue
		}
		v := v
		t.Run(v.Name, func(t *testing.T) {
			if cyclicVectors[v.Name] {
				build, ok := cyclicInputs[v.Name]
				if !ok {
					t.Fatalf("no input for cyclic vector %s", v.Name)
				}
				w := New()
				build(w)
				if err := w.FlushResume(); err == nil {
					t.Fatalf("expected an out-of-scope error for %s, got none", v.Name)
				} else if !strings.Contains(err.Error(), "cyclic") {
					t.Fatalf("expected a cycle error, got %v", err)
				}
				return
			}
			build, ok := vectorInputs[v.Name]
			if !ok {
				t.Fatalf("no input transcribed for vector %s (%s)", v.Name, v.Scopes)
			}
			got, err := payloadOf(t, build)
			if err != nil {
				t.Fatalf("serialize: %v", err)
			}
			if got != v.ExpectedPayload {
				t.Errorf("payload mismatch\n got: %s\nwant: %s", got, v.ExpectedPayload)
			}
		})
		checked++
	}
	if checked != 54 {
		t.Errorf("expected 54 serializer vectors, ran %d", checked)
	}
}

// cyclicInputs stage the two cycle vectors so the error path is exercised
// with the real shapes, not a synthetic stand-in.
var cyclicInputs = map[string]buildFn{
	"ser/cycle_self": func(w *Writer) {
		o := ScopeStateOf("v", 1)
		o.Set("self", o)
		w.AddScope(1, ScopeStateOf("a", o))
	},
	"ser/cycle_mutual": func(w *Writer) {
		x, y := NewScopeState(), NewScopeState()
		x.Set("y", y)
		y.Set("x", x)
		w.AddScope(1, ScopeStateOf("a", x))
	},
}

func TestFormatJSNumber(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		// Contract section 9's table, verbatim.
		{42, "42"},
		{0, "0"},
		{math.Copysign(0, -1), "0"},
		{1.5, "1.5"},
		{-0.25, "-0.25"},
		{1e20, "100000000000000000000"},
		{1e21, "1e+21"},
		{1e-6, "0.000001"},
		{1e-7, "1e-7"},
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},

		// Threshold neighbours: the exponent switch is exclusive on one
		// side and inclusive on the other, so both sides are pinned.
		{1e-5, "0.00001"},
		{1.5e-7, "1.5e-7"},
		{1e-21, "1e-21"},
		{-1e21, "-1e+21"},
		{9.999999999999999e20, "999999999999999900000"},
		{1.2345e21, "1.2345e+21"},

		// Plain values, negatives and shortest-round-trip digits.
		{-42, "-42"},
		{0.1, "0.1"},
		{1 / 3.0, "0.3333333333333333"},
		{123456789, "123456789"},
		{math.MaxFloat64, "1.7976931348623157e+308"},
		{5e-324, "5e-324"},
	}
	for _, c := range cases {
		if got := formatJSNumber(c.in); got != c.want {
			t.Errorf("formatJSNumber(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestQuoteJSEscapes(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain", `"plain"`},
		{`he said "hi"`, `"he said \"hi\""`},
		{`a\b`, `"a\\b"`},
		{"a<b", `"a\x3Cb"`},
		// `<` -> \x3C is what makes this safe; there is no separate case.
		{"</script>", `"\x3C/script>"`},
		{"a\nb\rc", `"a\nb\rc"`},
		{"a\x00b", `"a\x00b"`},
		{"a\u2028b\u2029c", `"a\u2028b\u2029c"`},
		// Everything below is deliberately NOT escaped.
		{"it's a 'test'", `"it's a 'test'"`},
		{"a\tb", "\"a\tb\""},
		{"héllo", `"héllo"`},
		{"hi 👋🏽 there", `"hi 👋🏽 there"`},
		{"a" + loneSurrogate(0xD800) + "b", `"a\ud800b"`},
		{loneSurrogate(0xDFFF), `"\udfff"`},
	}
	for _, c := range cases {
		if got := quoteJS(c.in); got != c.want {
			t.Errorf("quoteJS(%q) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestNextIDAlphabet(t *testing.T) {
	s := newSerializer()
	var got []string
	for i := 0; i < 60; i++ {
		got = append(got, s.nextID())
	}
	// First char comes from `n % 53`, so `_` (index 53) is unreachable --
	// which is what keeps `_._` free for the runtime registry.
	checks := map[int]string{0: "a", 25: "z", 26: "A", 51: "Z", 52: "$", 53: "ab", 59: "gb"}
	for i, want := range checks {
		if got[i] != want {
			t.Errorf("nextID #%d = %q, want %q", i, got[i], want)
		}
	}
	for i, id := range got {
		if strings.HasPrefix(id, "_") {
			t.Errorf("nextID #%d = %q starts with the reserved `_`", i, id)
		}
	}
}

func TestObjectKeyForms(t *testing.T) {
	cases := []struct{ in, want string }{
		{"abc", "abc"},
		{"$x", "$x"},
		{"_y", "_y"},
		{"0", "0"},
		{"12", "12"},
		{"01", `"01"`},
		{"a-b", `"a-b"`},
		{"", `""`},
		{"__proto__", `["__proto__"]`},
		{"123456789012345", "123456789012345"},
		{"12345678901234567890", `"12345678901234567890"`},
	}
	for _, c := range cases {
		if got := toObjectKey(c.in); got != c.want {
			t.Errorf("toObjectKey(%q) = %s, want %s", c.in, got, c.want)
		}
	}
}

// TestScopeStateKeyOrder pins the JS enumeration rule: integer-like keys
// first in ascending numeric order, then the rest in insertion order.
func TestScopeStateKeyOrder(t *testing.T) {
	s := ScopeStateOf("zeta", 1, "10", 2, "alpha", 3, "2", 4)
	got := strings.Join(s.Keys(), ",")
	if want := "2,10,zeta,alpha"; got != want {
		t.Errorf("Keys() = %q, want %q", got, want)
	}

	got2, err := payloadOf(t, func(w *Writer) { w.AddScope(1, s) })
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := "_=>[1,{2:4,10:2,zeta:1,alpha:3}]"; got2 != want {
		t.Errorf("payload = %s, want %s", got2, want)
	}
}

// TestStringDedupBoundary pins the 12/13 char boundary, a magic constant in
// the JS runtime that silently moves payload bytes if it ever changes.
func TestStringDedupBoundary(t *testing.T) {
	twelve := "123456789012"
	thirteen := "1234567890123"

	got, err := payloadOf(t, scope(1, "a", twelve, "b", twelve))
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := `_=>[1,{a:"123456789012",b:"123456789012"}]`; got != want {
		t.Errorf("12-char string deduped\n got: %s\nwant: %s", got, want)
	}

	got, err = payloadOf(t, scope(1, "a", thirteen, "b", thirteen))
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := `_=>[1,{a:_.a="1234567890123",b:_.a}]`; got != want {
		t.Errorf("13-char string not deduped\n got: %s\nwant: %s", got, want)
	}
}

// TestDedupIsIdentityBased checks that two structurally equal but distinct
// objects are NOT merged, matching the JS WeakMap.
func TestDedupIsIdentityBased(t *testing.T) {
	got, err := payloadOf(t, func(w *Writer) {
		w.AddScope(1, ScopeStateOf("a", ScopeStateOf("v", 1), "b", ScopeStateOf("v", 1)))
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := "_=>[1,{a:{v:1},b:{v:1}}]"; got != want {
		t.Errorf("distinct equal objects were deduped\n got: %s\nwant: %s", got, want)
	}
}

func TestScopeMergeOnRepeatedAdd(t *testing.T) {
	got, err := payloadOf(t, func(w *Writer) {
		w.AddScope(1, ScopeStateOf("a", 1))
		w.AddScope(1, ScopeStateOf("b", 2))
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := "_=>[1,{a:1,b:2}]"; got != want {
		t.Errorf("repeated AddScope did not merge\n got: %s\nwant: %s", got, want)
	}
}

// TestScopesSortedRegardlessOfCallOrder pins the explicit sort Go needs but
// JS gets free from numeric-string key ordering.
func TestScopesSortedRegardlessOfCallOrder(t *testing.T) {
	got, err := payloadOf(t, func(w *Writer) {
		w.AddScope(5, ScopeStateOf("a", 1))
		w.AddScope(2, ScopeStateOf("b", 2))
		w.AddScope(0, ScopeStateOf("gg", 9))
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := "_=>[0,{gg:9},1,{b:2},2,{a:1}]"; got != want {
		t.Errorf("scopes not emitted ascending\n got: %s\nwant: %s", got, want)
	}
}

func TestMarkerEmission(t *testing.T) {
	w := New()
	w.HTML("<button>0")
	w.Marker(OpResume, 1, "b")
	w.HTML("</button>")
	w.Marker(OpResume, 1, "a")
	got := w.String()
	want := "<button>0<!--M_*1 b--></button><!--M_*1 a-->"
	if got != want {
		t.Errorf("markers\n got: %s\nwant: %s", got, want)
	}
}

func TestMarkerHonoursCustomIDs(t *testing.T) {
	w := New()
	w.SetResumeIDs("Zz", "r1")
	w.Marker(OpResume, 1, "a")
	if got, want := w.String(), "<!--Zzr1*1 a-->"; got != want {
		t.Errorf("marker = %s, want %s", got, want)
	}
}

func TestCustomIDsInPayload(t *testing.T) {
	w := New()
	w.SetResumeIDs("Zz", "r1")
	w.AddScope(1, ScopeStateOf("a", 1))
	if err := w.FlushResume(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	out := w.String()
	if !strings.Contains(out, `("Zz")("r1");Zz.r1.r=[_=>[1,{a:1}]]`) {
		t.Errorf("custom ids not threaded through: %s", out)
	}
}

func TestInvalidResumeIDsError(t *testing.T) {
	w := New()
	w.SetResumeIDs("has-dash", "_")
	w.AddScope(1, ScopeStateOf("a", 1))
	if err := w.FlushResume(); err == nil {
		t.Fatal("expected an error for an invalid runtime id")
	}
}

// TestScriptEntryCollapse pins the consecutive-same-registryId collapse.
func TestScriptEntryCollapse(t *testing.T) {
	w := New()
	w.AddScript("R1", 1)
	w.AddScript("R1", 2)
	w.AddScript("R2", 3)
	w.AddScript("R1", 4)
	if got, want := w.res.effects, "R1 1 2 R2 3 R1 4"; got != want {
		t.Errorf("effects = %q, want %q", got, want)
	}
}

// TestEffectsAreLastArrayElement pins the ordering rule: scopes first, the
// effects string last, regardless of call order.
func TestEffectsAreLastArrayElement(t *testing.T) {
	got, err := payloadOf(t, func(w *Writer) {
		w.AddScript("WDGvDBz", 1)
		w.AddScope(1, ScopeStateOf("c", 0))
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := `_=>[1,{c:0}],"WDGvDBz 1"`; got != want {
		t.Errorf("payload\n got: %s\nwant: %s", got, want)
	}
}

// TestWalkIsConditional pins the trap from contract section 1: `M._.w()` is
// emitted only when the flush produced an effects string.
func TestWalkIsConditional(t *testing.T) {
	// p01-counter: has a script entry -> .w() present.
	w := New()
	w.AddScope(1, ScopeStateOf("c", 0))
	w.AddScript("WDGvDBz", 1)
	if err := w.FlushResume(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if got := w.String(); !strings.HasSuffix(got, `M._.r=[_=>[1,{c:0}],"WDGvDBz 1"];M._.w()</script>`) {
		t.Errorf("expected a trailing .w(), got: %s", got)
	}

	// p05-composed: markers and scopes but NO script entry -> no .w().
	w2 := New()
	w2.AddScope(1, ScopeStateOf("d", NewScopeState()))
	w2.AddScope(3, ScopeStateOf("_", Scope(1)))
	if err := w2.FlushResume(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	out := w2.String()
	if strings.Contains(out, ".w()") {
		t.Errorf("unexpected .w() with no effects string: %s", out)
	}
	if !strings.HasSuffix(out, "]</script>") {
		t.Errorf("payload did not close cleanly: %s", out)
	}
}

// TestNoScriptWhenNothingToResume pins p11-optional-body-empty: a render with
// nothing serialized emits no <script> at all.
func TestNoScriptWhenNothingToResume(t *testing.T) {
	w := New()
	w.HTML("<div>hi</div>")
	if err := w.FlushResume(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if got, want := w.String(), "<div>hi</div>"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}

	// A marker alone still does not produce a payload.
	w2 := New()
	w2.HTML("<div>hi</div>")
	w2.Marker(OpResume, 1, "a")
	if err := w2.FlushResume(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if strings.Contains(w2.String(), "<script>") {
		t.Errorf("unexpected script: %s", w2.String())
	}
}

// TestPayloadPrecedesTrailers pins p10-trailers: the script sits immediately
// before the closing </body></html>.
func TestPayloadPrecedesTrailers(t *testing.T) {
	w := New()
	w.HTML("<html><body><button>0")
	w.Marker(OpResume, 1, "b")
	w.HTML("</button>")
	w.Marker(OpResume, 1, "a")
	w.Trailer("</body></html>")
	w.AddScope(1, ScopeStateOf("c", 0))
	w.AddScript("lLlrMWf", 1)
	if err := w.FlushResume(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	got := w.String()
	if !strings.HasPrefix(got, "<html><body><button>0<!--M_*1 b--></button><!--M_*1 a--><script>") {
		t.Errorf("markup prefix wrong: %s", got)
	}
	if !strings.HasSuffix(got, "</script></body></html>") {
		t.Errorf("trailer not after script: %s", got)
	}
}

// TestTrailersFlushWithoutResume checks the safety net: a render that never
// calls FlushResume still gets its trailer markup.
func TestTrailersFlushWithoutResume(t *testing.T) {
	w := New()
	w.HTML("<html><body>hi")
	w.Trailer("</body></html>")
	if got, want := w.String(), "<html><body>hi</body></html>"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestBootstrapEmittedOnce(t *testing.T) {
	w := New()
	w.AddScope(1, ScopeStateOf("a", 1))
	if err := w.FlushResume(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if n := strings.Count(w.String(), bootstrapRuntimeCode); n != 1 {
		t.Errorf("bootstrap appeared %d times, want 1", n)
	}
}

func TestUnsupportedValueErrors(t *testing.T) {
	w := New()
	w.AddScope(1, ScopeStateOf("a", struct{ X int }{1}))
	err := w.FlushResume()
	if err == nil {
		t.Fatal("expected an unsupported-type error")
	}
	if !strings.Contains(err.Error(), "unsupported serialized type") {
		t.Errorf("unexpected error: %v", err)
	}
}

// TestEmptyScopeSkipped pins that a scope with no props vanishes entirely,
// so the next scope becomes the array head.
func TestEmptyScopeSkipped(t *testing.T) {
	got, err := payloadOf(t, seq(scope(1), scope(2, "a", 1)))
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := "_=>[2,{a:1}]"; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

// TestArrowHeadChosenAfterSerialization pins that `$` in a LATER property
// still promotes the head for the whole entry.
func TestArrowHeadChosenAfterSerialization(t *testing.T) {
	got, err := payloadOf(t, scope(1, "a", 1, "b", []any{Undefined}))
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if want := "(_,$)=>[1,{a:1,b:[$]}]"; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}
