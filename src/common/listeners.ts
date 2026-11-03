/**
 * Invokes listeners following the DOM EventTarget semantics.
 * Takes a snapshot of listeners: listeners added during callbacks are not called in the current dispatch,
 * and listeners removed during callbacks are skipped. Each listener is invoked in isolation so exceptions do not abort
 * other listeners or the caller, while errors are still reported via {@link report}.
 * @see https://dom.spec.whatwg.org/#concept-event-listener-invoke
 * @see https://dom.spec.whatwg.org/#concept-event-listener-inner-invoke
 */
export function notifyAll<T extends unknown[]>(listeners: Iterable<(...args: T) => void>, ...args: T) {
  for (const listener of [...listeners]) {
    if (listeners instanceof Set && !listeners.has(listener)) continue;
    try {
      listener(...args);
    } catch (error) {
      report(error);
    }
  }
}

type Reporting = { reportError?: (error: unknown) => void; ErrorUtils?: { reportError: (error: unknown) => void } };

/**
 * Reports an unhandled exception without interrupting the caller, following HTML's report the exception.
 * Uses `reportError` in browsers and Workers, `ErrorUtils.reportError` in React Native to route into non-fatal app error handlers,
 * or re-throws in a microtask when neither is available.
 * @see https://html.spec.whatwg.org/multipage/webappapis.html#dom-reporterror
 * @see https://github.com/facebook/react-native/blob/main/packages/polyfills/error-guard.js
 */
export function report(error: unknown) {
  const global = globalThis as Reporting;
  if (global.reportError) global.reportError(error);
  else if (global.ErrorUtils) global.ErrorUtils.reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}
