import { expect, test } from 'vitest';
import { deserializeError, serializeError } from '../../src/expo/errors.ts';

// Reconstructs errors passed from Worker to page through postMessage structured cloning.

const across = (error: unknown) => deserializeError(structuredClone(serializeError(error)));

test('Worker errors retain message without prepending "Error: "', () => {
  expect(across(new Error('Local database is closed'))).toEqual(new Error('Local database is closed'));
  expect(across('broken')).toEqual(new Error('broken'));
});

test('other errors preserve Worker stack trace across boundary so caller can locate failure', () => {
  const original = new Error('Pull failed');
  expect(across(original).stack).toBe(original.stack);
});

test('an error without a stack trace (stack is non-standard) serializes its message alone', () => {
  const bare = new Error('Pull failed');
  delete bare.stack;
  expect(serializeError(bare)).toStrictEqual({ message: 'Pull failed' });
});
