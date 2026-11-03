/**
 * 一段文字的指纹（FNV-1a）：32 位的给规则索引的名字、行哈希；64 位的给两端各自算、只比相等的表结构
 * @see http://www.isthe.com/chongo/tech/comp/fnv/
 */
export function fingerprintOf(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
}

/** 64 位（FNV-1a 64），16 位十六进制 */
export function longFingerprintOf(text: string) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(index))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
