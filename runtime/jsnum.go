package runtime

import (
	"math"
	"strconv"
	"strings"
)

// formatJSNumber replicates ECMAScript `Number::toString(x, 10)` -- i.e. what
// JS `val + ""` produces -- for a float64.
//
// The Marko serializer writes numbers with `state.buf.push(val + "")`
// (html.mjs:1146), so byte-exact resume payloads require byte-exact JS number
// formatting. Go's strconv does NOT match at three points, all of which this
// function fixes:
//
//   - Exponent thresholds. JS switches to exponential form iff the decimal
//     exponent is >= 21 or < -6. Go's 'g' verb switches much earlier, so
//     1e20 must print as "100000000000000000000" (not "1e+20") and 1e-6 as
//     "0.000001" (not "1e-06").
//   - Exponent padding. JS writes "1e-7"; Go writes "1e-07".
//   - Negative zero. JS `-0 + ""` is "0"; Go's FormatFloat keeps the sign.
//
// NaN and the infinities render as the bare JS identifiers `NaN`, `Infinity`
// and `-Infinity`. Those are valid expressions in the payload's evaluation
// context and decode back to the same values.
//
// Resume support; generated code only; not stable.
func formatJSNumber(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "Infinity"
	case math.IsInf(v, -1):
		return "-Infinity"
	case v == 0:
		// Covers -0: JS drops the sign.
		return "0"
	}

	neg := v < 0
	if neg {
		v = -v
	}

	// Shortest round-trip decimal digits plus a base-10 exponent, which is
	// exactly the (s, k, n) triple ECMAScript's Number::toString is defined
	// over. 'e' format gives us "d.dddde±dd", from which digits and exponent
	// are trivially recovered.
	mant := strconv.FormatFloat(v, 'e', -1, 64)
	ePos := strings.IndexByte(mant, 'e')
	exp, err := strconv.Atoi(mant[ePos+1:])
	if err != nil {
		// Unreachable for finite values; fall back to Go's formatting.
		return mant
	}
	digits := strings.Replace(mant[:ePos], ".", "", 1)

	// k = number of significant digits, n = position of the decimal point
	// relative to the digit string (value = 0.digits * 10^n).
	k := len(digits)
	n := exp + 1

	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}

	switch {
	case n >= 1 && n <= 21:
		if k <= n {
			// Integer with trailing zeros: "digits" + (n-k) zeros.
			b.WriteString(digits)
			b.WriteString(strings.Repeat("0", n-k))
		} else {
			// Decimal point falls inside the digit string.
			b.WriteString(digits[:n])
			b.WriteByte('.')
			b.WriteString(digits[n:])
		}
	case n <= 0 && n > -6:
		// Leading "0." plus -n zeros.
		b.WriteString("0.")
		b.WriteString(strings.Repeat("0", -n))
		b.WriteString(digits)
	default:
		// Exponential form. JS writes a single leading digit, then "."
		// and the rest only when there is more than one digit, then
		// "e+"/"e-" with an UNPADDED exponent.
		b.WriteString(digits[:1])
		if k > 1 {
			b.WriteByte('.')
			b.WriteString(digits[1:])
		}
		if n-1 >= 0 {
			b.WriteString("e+")
		} else {
			b.WriteString("e-")
		}
		b.WriteString(strconv.Itoa(abs(n - 1)))
	}
	return b.String()
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
