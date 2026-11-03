import { onTestFinished, vi } from 'vitest';

// Test harness utilities: captures globally reported errors (reportError for listener and shrink errors).

/** Captures errors reported via reportError into returned array; cleans up globals after test finishes. */
export function captureReported() {
  const reported: string[] = [];
  vi.stubGlobal('reportError', (error: Error) => reported.push(error.message));
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return reported;
}
