import type { Op } from './protocol.ts';

// Measures payload sizes: platform ceilings in bytes (WebSocket message size, Durable Object values and rows) use UTF-8 byte lengths,
// measured via utf8Bytes and fitsBytes in JavaScript or octet_length in SQL.
// Internal budgets (pull chunk limits, checksum ranges, broadcast payload caps) measure UTF-16 characters directly via opChars to avoid serialization overhead.

const encoder = new TextEncoder();

/** Returns the UTF-8 byte length of a string. */
export const utf8Bytes = (text: string) => encoder.encode(text).length;

/** Checks whether a string fits within a UTF-8 byte limit, checking character length first as an early exit. */
export const fitsBytes = (text: string, limit: number) => text.length <= limit && utf8Bytes(text) <= limit;

/** Returns the character count of an operation serialized as JSON. */
export const opChars = (op: Op) => JSON.stringify(op).length;
