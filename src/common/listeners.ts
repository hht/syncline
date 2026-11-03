/**
 * 订阅者怎么调用，照 DOM 的 EventTarget：先照下这一刻的订阅者，回调里新订阅的这次不调、已退订的不再调；每个订阅者单独调用，
 * 一个抛错不影响别的、也不影响调用方（本机写已经提交、连接还要推送），错误照常报出（report），不吞掉。
 * 不该知道的：订阅的是什么事。
 * @see https://dom.spec.whatwg.org/#concept-event-listener-invoke（clone of the listener list、removed）
 * @see https://dom.spec.whatwg.org/#concept-event-listener-inner-invoke（report the exception）
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
 * 照常报出一个错、不中断调用方，照 HTML 的 report the exception：浏览器与 Workers 有 reportError；RN 没有，用 ErrorUtils.reportError，
 * 进 App 的全局错误处理、非致命（在微任务里重新抛的错 RN 当致命错误，release 包闪退）；都没有的（Node）在微任务里重新抛
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
