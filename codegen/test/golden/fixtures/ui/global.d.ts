// Request-scoped globals available as $global.* in every template.
declare global {
  namespace Marko {
    interface Global {
      /** Current request path, e.g. "/counter". */
      path: string;
    }
  }
}

export {};
