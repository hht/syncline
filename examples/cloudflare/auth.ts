import type { User } from './definition.ts';

// Stand-in for your own token check (Firebase, Auth0, your sessions): a JSON payload signed with HMAC-SHA256 under a secret.
// @see https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

const encoder = new TextEncoder();

const keyOf = (secret: string) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const bytesOf = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));

/** Signs a token for user; tests and your sign-in endpoint call it. */
export async function signToken(user: User, secret: string) {
  const payload = base64url(encoder.encode(JSON.stringify(user)));
  const signature = await crypto.subtle.sign('HMAC', await keyOf(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** Returns the user a token was signed for, or undefined when the signature does not match or the token has expired. */
export async function verifyToken(token: string, secret: string): Promise<User | undefined> {
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length > 0) return undefined;
  try {
    const valid = await crypto.subtle.verify('HMAC', await keyOf(secret), bytesOf(signature), encoder.encode(payload));
    const user = valid ? (JSON.parse(new TextDecoder().decode(bytesOf(payload))) as User) : undefined;
    return user && user.expiresAt > Date.now() ? user : undefined;
  } catch {
    return undefined;
  }
}
