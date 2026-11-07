import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from 'vitest';
import { download } from '../src/prebuilt.mjs';
import { androidAbis, iosTargets, pack, webFiles } from './release.ts';

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
  const assets = pack(dir, { 'one.a': join(sources, 'a'), 'two.so': join(sources, 'b') }, '1.2.3', 'abc');
  return { dir, assets };
}

test('a release packs gzipped binaries and a manifest that downloads write back byte for byte', async () => {
  const { dir, assets } = release();
  expect(assets.map((path) => basename(path))).toEqual(['one.a.gz', 'two.so.gz', 'manifest.json']);
  expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({ version: '1.2.3', commit: 'abc' });
  await using server = await serve(dir);
  const out = mkdtempSync(join(tmpdir(), 'syncline-install-'));
  const binaries: [string, string][] = [
    ['one.a', join(out, 'nested/one.a')],
    ['two.so', join(out, 'two.so')],
  ];
  await download(server.base, binaries);
  expect(readFileSync(join(out, 'nested/one.a'), 'utf8')).toBe('first binary');
  expect(readFileSync(join(out, 'two.so'), 'utf8')).toBe('second binary');
  // Binaries already written were verified then; later builds work offline.
  await download(server.base, binaries);
  expect(server.requests).toEqual(['manifest.json', 'one.a.gz', 'two.so.gz']);
});

test('a download whose digest differs from the manifest writes nothing', async () => {
  const { dir } = release();
  await using server = await serve(dir, (name, body) => (name === 'one.a.gz' ? Buffer.concat([body, Buffer.from('x')]) : body));
  const out = mkdtempSync(join(tmpdir(), 'syncline-install-'));
  await expect(download(server.base, [['one.a', join(out, 'one.a')]])).rejects.toThrow(
    /one\.a\.gz has SHA-256 \w+, but the release manifest records \w+/,
  );
  expect(readdirSync(out)).toEqual([]);
});

test('a version without a release tells to install a release tag', async () => {
  await using server = await serve(mkdtempSync(join(tmpdir(), 'syncline-empty-')));
  await expect(download(server.base, [['one.a', join(tmpdir(), 'unused')]])).rejects.toThrow(
    /manifest\.json failed with HTTP 404\. .*install a release tag/,
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
