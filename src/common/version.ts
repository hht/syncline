/**
 * Wire protocol version negotiation between device and cloud.
 * Device passes its protocol version in query parameters; mismatches determine whether to halt for app upgrades or retry with backoff.
 */

/**
 * Wire protocol version incremented only on breaking wire changes.
 * Device passes `v=version` in pull and connection URLs, isolating edge cache keys across protocol revisions.
 * Version mismatches return HTTP 409 or close WebSockets with code 4002.
 * Newer cloud prompts app upgrades; older cloud triggers retry with backoff.
 * @see https://doc.replicache.dev/api/classes/Replicache#onupdateneeded
 * @see https://github.com/rocicorp/mono/blob/main/packages/zero-protocol/src/protocol-version.ts
 */
export const protocolVersion = 5;
export const versionParam = 'v';
export const versionMismatch = 4002;
export const versionConflict = 409;

/** Protocol version mismatch error indicating incompatible device and cloud wire versions. */
export class VersionMismatch extends Error {
  readonly cloud: number;

  constructor(cloud: number) {
    super(
      cloud > protocolVersion
        ? `Cloud protocol version ${cloud} is newer; update the application`
        : `Cloud protocol version ${cloud} is older; wait for deployment to complete`,
    );
    this.cloud = cloud;
  }
}
