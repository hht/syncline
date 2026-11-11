import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { digestsFile, download, releaseOf } from '../src/prebuilt.mjs';
import { androidAbis, iosTargets, pack, stamp, webFiles } from './release.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** Serves the files of `dir` as a release, counting requests per file name. */
async function serve(dir: string, edit: (name: string, body: Buffer) => Buffer = (_, body) => body) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const name = basename(request.url ?? '');
    requests.push(name);
    try {
      response.end(edit(name, readFileSync(join(dir, name))));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    [Symbol.asyncDispose]: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function release() {
  const sources = mkdtempSync(join(tmpdir(), 'syncline-binaries-'));
  writeFileSync(join(sources, 'a'), 'first binary');
  writeFileSync(join(sources, 'b'), 'second binary');
  const dir = mkdtempSync(join(tmpdir(), 'syncline-release-'));
  return { dir, ...pack(dir, { 'one.a': join(sources, 'a'), 'two.so': join(sources, 'b') }) };
}

test('a release packs gzipped binaries with the digests downloads check them against, writing them back byte for byte', async () => {
  const { dir, assets, digests } = release();
  expect(assets.map((path) => basename(path))).toEqual(['one.a.gz', 'two.so.gz']);
  await using server = await serve(dir);
  const out = mkdtempSync(join(tmpdir(), 'syncline-install-'));
  const binaries: [string, string][] = [
    ['one.a', join(out, 'nested/one.a')],
    ['two.so', join(out, 'two.so')],
  ];
  await download(server.base, digests, binaries);
  expect(readFileSync(join(out, 'nested/one.a'), 'utf8')).toBe('first binary');
  expect(readFileSync(join(out, 'two.so'), 'utf8')).toBe('second binary');
  // Binaries already written were verified then; later builds work offline.
  await download(server.base, digests, binaries);
  expect(server.requests).toEqual(['one.a.gz', 'two.so.gz']);
});

test('a release asset replaced by another binary, whose digest differs from the one the package records, writes nothing', async () => {
  const { dir, digests } = release();
  await using server = await serve(dir, (name, body) => (name === 'one.a.gz' ? gzipSync('another binary') : body));
  const out = mkdtempSync(join(tmpdir(), 'syncline-install-'));
  await expect(download(server.base, digests, [['one.a', join(out, 'one.a')]])).rejects.toThrow(
    /one\.a\.gz has SHA-256 \w+, but this package records \w+/,
  );
  // An asset the package records no digest for is refused the same way.
  await expect(download(server.base, {}, [['two.so', join(out, 'two.so')]])).rejects.toThrow(
    /two\.so\.gz has SHA-256 \w+, but this package records undefined/,
  );
  expect(readdirSync(out)).toEqual([]);
});

test('a release stamps its version and digests where an install reads them, and the reset after it stamps a version without digests', () => {
  const root = mkdtempSync(join(tmpdir(), 'syncline-tree-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), read('package.json'));
  const { digests } = release();
  expect(stamp(root, '1.2.3', digests)).toEqual(['package.json', 'src/prebuilt.json']);
  expect(releaseOf(root)).toEqual({ base: 'https://github.com/hht/syncline/releases/download/v1.2.3', digests });
  stamp(root, '0.0.0', {});
  expect(releaseOf(root)).toEqual({ base: 'https://github.com/hht/syncline/releases/download/v0.0.0', digests: {} });
  // This tree records digests too, none outside a release, and installs carry the file: none of the package's exclusions match it.
  expect(Object.values(releaseOf(fileURLToPath(new URL('..', import.meta.url))).digests).join()).toMatch(/^([0-9a-f]{64},?)*$/);
  const { files }: { files: string[] } = JSON.parse(read('package.json'));
  expect(files).toContain('src');
  expect(files.filter((pattern) => pattern.startsWith('!') && matchesGlob(digestsFile, pattern.slice(1)))).toEqual([]);
});

test('a version without a release, which records no digests, tells to install a release tag', async () => {
  await using server = await serve(mkdtempSync(join(tmpdir(), 'syncline-empty-')));
  await expect(download(server.base, {}, [['one.a', join(tmpdir(), 'unused')]])).rejects.toThrow(
    /one\.a\.gz failed with HTTP 404\. .*install a release tag/,
  );
});

test('the build wrappers download the assets a release publishes', () => {
  const ios = read('ios/build-rust.sh');
  expect([...ios.matchAll(/targets\+=\(([\w-]+)\)/g)].map(([, target]) => target)).toEqual(iosTargets);
  expect(ios).toMatch(/"libsyncline_native-\$\{targets\[\$i\]\}\.a"/);
  const android = read('android/build.gradle');
  expect(android.match(/reactNativeArchitectures"\) \?: "([^"]+)"/)?.[1]?.split(',')).toEqual(androidAbis);
  expect(android).toMatch(/"libsyncline_native-\$\{it\}\.so"/);
  expect(read('metro.cjs')).toContain(`[${webFiles.map((file) => `'${file}'`).join(', ')}]`);
});
