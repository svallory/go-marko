package runtime

// ForOf iterates items in order. It's the Go target for
// `<for|item| of=items>` with no `by` key -- no diffing/keying/resume
// bookkeeping, since this runtime never re-renders in place.
func ForOf[T any](items []T, fn func(item T)) {
	for _, item := range items {
		fn(item)
	}
}

// ForOfIndexed is the Go target for `<for|item, i| of=items>`.
func ForOfIndexed[T any](items []T, fn func(item T, i int)) {
	for i, item := range items {
		fn(item, i)
	}
}
