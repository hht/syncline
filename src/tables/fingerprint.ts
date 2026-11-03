/**
 * Computes an FNV-1a hash fingerprint.
 * 32-bit hashes are used for rule index names and row content hashes; 64-bit hex fingerprints are used for schema declarations.
 * @see http://www.isthe.com/chongo/tech/comp/fnv/
 */
export function fingerprintOf(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
}

/** Computes a 64-bit FNV-1a hash, formatted as a 16-character hexadecimal string. */
export function longFingerprintOf(text: string) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(index))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
