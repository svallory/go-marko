package runtime

// Body is the Go target for a Marko tag's `content` input: a callback that
// writes the tag's nested body into the parent Writer. Generated code
// produces these from `_content`/`_content_resume` calls
// (@marko/runtime-tags/src/dynamic-tag.ts) -- see fr1-design.md's
// "cross-module tag imports" section for the translation rule
// (`content:` becomes `func(w *runtime.Writer) { ... }`).
type Body func(w *Writer)
