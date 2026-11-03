import { onTestFinished, vi } from 'vitest';

// 测试共用：接住照常报出的错误（report，订阅者抛的、收缩库文件出的）

/** 接住这个测试里报出的错误，收进返回的数组；测试结束时（含失败）恢复 */
export function captureReported() {
  const reported: string[] = [];
  vi.stubGlobal('reportError', (error: Error) => reported.push(error.message));
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return reported;
}
