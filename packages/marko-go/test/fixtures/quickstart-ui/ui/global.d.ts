// Request-scoped globals available as $global.* in every template.
// The Go side provides these per-request via marko.WithGlobals (see
// main.go); marko-go generates the ui.Globals struct from this interface.
declare global {
  namespace Marko {
    interface Global {
      /** Current request path, e.g. "/counter". */
      path: string;
    }
  }
}

export {};
