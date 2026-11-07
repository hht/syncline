import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * Downloads the device binaries of this package's release from GitHub Releases. Installs carry no Rust sources to build them from (the
 * package's `files` field leaves them out), so the iOS and Android builds and withSyncline run this instead of cargo, writing each binary
 * inside the installed package, which each version installs afresh. Each release asset is gzipped, and the release's manifest records its
 * SHA-256 (both written by the release script).
 * Integrators run it from dependencies where Node does not strip TypeScript types, so this script is plain JavaScript.
 * @see https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases
 */

/**
 * Writes each asset of the release at `base` to its destination, skipping destinations that exist: one is only ever written after its
 * digest matched the manifest.
 * @param {string} base download URL of the release
 * @param {[asset: string, destination: string][]} binaries
 */
export async function download(base, binaries) {
  const missing = binaries.filter(([, destination]) => !existsSync(destination));
  if (missing.length === 0) return;
  /** @type {{ files: Record<string, string> }} */
  const { files } = JSON.parse((await fetchAsset(base, 'manifest.json')).toString('utf8'));
  for (const [asset, destination] of missing) {
    const name = `${asset}.gz`;
    const body = await fetchAsset(base, name);
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== files[name]) throw new Error(`${base}/${name} has SHA-256 ${digest}, but the release manifest records ${files[name]}`);
    mkdirSync(dirname(destination), { recursive: true });
    // Flushed and renamed into place so neither an interrupted run nor a power loss leaves a destination later runs would skip; named per
    // process so concurrent builds never write into the file another is renaming.
    const partial = `${destination}.${process.pid}.partial`;
    const file = openSync(partial, 'w');
    writeSync(file, gunzipSync(body));
    fsyncSync(file);
    closeSync(file);
    renameSync(partial, destination);
  }
}

/**
 * @param {string} base
 * @param {string} name
 */
async function fetchAsset(base, name) {
  const response = await fetch(`${base}/${name}`);
  if (!response.ok)
    throw new Error(
      `Downloading ${base}/${name} failed with HTTP ${response.status}. Syncline downloads the binaries of the release its package.json version names: install a release tag (see README).`,
    );
  return Buffer.from(await response.arrayBuffer());
}

// Arguments are asset and destination pairs, passed by Syncline's own build wrappers. Compared by real path (package managers link
// packages) rather than import.meta.main, which Node versions before 24.2 lack: there the script would exit without downloading, and
// Android would build without its library.
if (realpathSync(process.argv[1] ?? '.') === realpathSync(fileURLToPath(import.meta.url))) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const args = process.argv.slice(2);
  /** @type {[string, string][]} */
  const binaries = [];
  for (let i = 0; i < args.length; i += 2) binaries.push([String(args[i]), String(args[i + 1])]);
  await download(`https://github.com/hht/syncline/releases/download/v${version}`, binaries);
}
