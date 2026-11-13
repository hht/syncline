import fc from 'fast-check';
import { expect, test } from 'vitest';
import { clientChars } from '../../src/common/limits.ts';
import { parseMutations } from '../../src/common/parse.ts';

// Cloud parses pushed batches at the trust boundary (the device core parses what the cloud sends).

/** Pushed value rules from the protocol: null, well-formed text, or a finite number. */
const valid = (value: unknown) => value === null || (typeof value === 'string' ? value.isWellFormed() : Number.isFinite(value));
const validIn = (values: unknown) => typeof values === 'object' && values !== null && Object.values(values).every(valid);
/** A change the cloud can execute: put or patch with valid row values, or del with valid key values. */
const executable = ({ op, row, key }: { op: string; row?: unknown; key?: unknown }) =>
  op === 'put' || op === 'patch' ? validIn(row) : op === 'del' && validIn(key);

test('pushed batches: valid identities always parse, and a mutation is held as malformed exactly when one of its changes is not executable', () => {
  const text = fc.string({
    unit: fc.oneof(fc.constantFrom('\uD800', '\uDC00'), fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })),
    maxLength: 70,
  });
  const value = fc.oneof({ arbitrary: text, weight: 4 }, fc.constant(null), fc.double(), fc.boolean());
  const row = fc.dictionary(fc.constantFrom('id', 'body'), value);
  const change = fc.record(
    { op: fc.constantFrom('put', 'patch', 'del', 'drop'), table: fc.constant('note'), row, key: row },
    { requiredKeys: ['op', 'table'] },
  );
  const mutation = fc.record(
    {
      client: fc.oneof({ arbitrary: fc.uuid(), weight: 4 }, text),
      id: fc.integer({ min: -1 }),
      first: fc.constantFrom(true, false),
      changes: fc.array(change, { minLength: 1, maxLength: 2 }),
    },
    { requiredKeys: ['client', 'id', 'changes'] },
  );
  fc.assert(
    fc.property(fc.array(mutation, { maxLength: 3 }), (generated) => {
      // The wire carries JSON: compare against what the cloud receives (non-finite numbers become null).
      const batch: (typeof generated)[number][] = JSON.parse(JSON.stringify(generated));
      const identified = batch.every(
        ({ client, id, first }) => client.length <= clientChars && client.isWellFormed() && id >= 0 && first !== false,
      );
      if (!identified) {
        expect(() => parseMutations(JSON.stringify(batch))).toThrow('Malformed');
        return;
      }
      const pushed = parseMutations(JSON.stringify(batch));
      expect(pushed.map((mutation) => 'malformed' in mutation)).toEqual(batch.map(({ changes }) => !changes.every(executable)));
    }),
  );
});
