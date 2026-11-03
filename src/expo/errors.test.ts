import { expect, test } from 'vitest';
import { ValidationError } from '../tables/validation.ts';
import { deserializeError, PendingWrites, serializeError } from './errors.ts';

// Reconstructs errors passed from Worker to page through postMessage structured cloning.

const across = (error: unknown) => deserializeError(structuredClone(serializeError(error)));

test('ValidationError crosses Worker boundary with table and paths; other errors retain message without prepending "Error: "', () => {
  const original = new ValidationError('workout', [{ path: ['note'], message: 'too long' }]);
  const restored = across(original);
  expect(restored).toBeInstanceOf(ValidationError);
  expect(restored).toMatchObject({ table: 'workout', issues: [{ path: ['note'], message: 'too long' }], message: original.message });
  expect(across(new Error('Local database is closed'))).toEqual(new Error('Local database is closed'));
  expect(across('broken')).toEqual(new Error('broken'));
});

test('other errors preserve Worker stack trace across boundary so caller can locate failure', () => {
  const original = new Error('Pull failed');
  expect(across(original).stack).toBe(original.stack);
});

test('PendingWrites crosses Worker boundary as PendingWrites with owner and count', () => {
  const restored = across(new PendingWrites('alice', 3));
  expect(restored).toBeInstanceOf(PendingWrites);
  expect(restored).toMatchObject({ owner: 'alice', count: 3 });
});
