/**
 * Thrown for any construct outside the supported subset. Always carries a
 * source location so failures point at real code, not this transpiler.
 *
 * The whole design of marko-go's codegen rests on this: we never emit Go
 * for something we only half-understand. A missing feature is a loud
 * compile-time error, never silently-wrong HTML at runtime.
 */
export class UnsupportedError extends Error {
  constructor(message, node) {
    const loc = node?.loc?.start;
    super(loc ? `${message} (at ${loc.line}:${loc.column})` : message);
    this.name = "UnsupportedError";
  }
}
