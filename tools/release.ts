import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildWasm } from '../rust/wasm/build.mjs';
import { digestsFile } from '../src/prebuilt.mjs';

/**
 * Publishes a release (`pnpm release <version>`): from a clean `dev` that passes `pnpm check`, builds the device binaries, commits the version
 * with their digests and tags it, resets `dev` to the unreleased version, pushes `dev` and the tag, attaches the gzipped binaries to a GitHub Release on the tag, and only then
 * merges the tag into `main` through a pull request, which takes only pull requests, so `main` always installs a release whose binaries
 * exist. Installs download the binaries with src/prebuilt.mjs. The binaries build from the tagged tree except its package.json version
 * and their own digests, which no binary build reads.
 * Out of scope: release notes beyond what GitHub generates.
 * @see https://cli.github.com/manual/gh_release_create
 * @see https://cli.github.com/manual/gh_pr_merge
 */

const root = resolve(import.meta.dirname, '..');
const workspace = join(root, 'rust');

/** iOS targets: device, Apple silicon simulators, Intel simulators. */
export const iosTargets = ['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'x86_64-apple-ios'];
/** Android ABIs React Native builds by default. */
export const androidAbis = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
/** Files of the web build that Syncline's Worker imports, with the declarations type-checking it needs. */
export const webFiles = ['syncline_wasm.js', 'syncline_wasm.d.ts', 'syncline_wasm_bg.wasm'];

/**
 * Gzips each binary into `dir` as `<asset>.gz`. Returns the paths to upload and each asset's SHA-256 by name, which src/prebuilt.mjs
 * checks a download against.
 */
export function pack(dir: string, binaries: Record<string, string>) {
  const digests: Record<string, string> = {};
  for (const [asset, path] of Object.entries(binaries)) {
    const body = gzipSync(readFileSync(path), { level: 9 });
    writeFileSync(join(dir, `${asset}.gz`), body);
    digests[`${asset}.gz`] = createHash('sha256').update(body).digest('hex');
  }
  return { assets: Object.keys(digests).map((name) => join(dir, name)), digests };
}

function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  // Expo's types require NODE_ENV in every ProcessEnv; nothing run here reads it.
  execFileSync(command, args, { cwd: options.cwd ?? root, stdio: 'inherit', env: options.env as NodeJS.ProcessEnv | undefined });
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Builds every release binary from the working tree, returning each asset's path. */
function build() {
  const cargo = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin/cargo');
  // Only what cargo needs, so flags in the releaser's shell (RUSTFLAGS, CFLAGS, SDKROOT) never reach the native binaries; the web build
  // runs as it does in development, with the shell's environment, which it needs to find LLVM through mise.
  const env = {
    HOME: homedir(),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    RUSTUP_TOOLCHAIN: '',
    ...(process.env.CARGO_HOME && { CARGO_HOME: process.env.CARGO_HOME }),
    ...(process.env.RUSTUP_HOME && { RUSTUP_HOME: process.env.RUSTUP_HOME }),
  };
  const binaries: Record<string, string> = {};
  // The minimum iOS version the pod declares, so the libraries link into any app the pod installs into.
  const ios = readFileSync(join(root, 'ios/Syncline.podspec'), 'utf8').match(/ios: '([\d.]+)'/)?.[1];
  if (!ios) throw new Error('ios/Syncline.podspec declares no iOS platform version');
  for (const target of iosTargets) {
    run(cargo, ['build', '--locked', '--release', '-p', 'syncline-native', '--target', target], {
      cwd: workspace,
      env: { ...env, IPHONEOS_DEPLOYMENT_TARGET: ios },
    });
    binaries[`libsyncline_native-${target}.a`] = join(workspace, `target/${target}/release/libsyncline_native.a`);
  }
  // React Native's minimum SDK and NDK, which apps build with unless they override them.
  const reactNative = dirname(
    createRequire(createRequire(import.meta.url).resolve('expo/package.json')).resolve('react-native/package.json'),
  );
  const versions = readFileSync(join(reactNative, 'gradle/libs.versions.toml'), 'utf8');
  const [minSdk, ndk] = ['minSdk', 'ndkVersion'].map((key) => versions.match(new RegExp(`^${key} = "([^"]+)"$`, 'm'))?.[1]);
  if (!minSdk || !ndk) throw new Error('React Native gradle/libs.versions.toml declares no minSdk or ndkVersion');
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk');
  const android = mkdtempSync(join(tmpdir(), 'syncline-android-'));
  run(
    cargo,
    [
      'ndk',
      '--platform',
      minSdk,
      '-o',
      android,
      ...androidAbis.flatMap((abi) => ['-t', abi]),
      'build',
      '--locked',
      '--release',
      '-p',
      'syncline-native',
    ],
    { cwd: workspace, env: { ...env, ANDROID_NDK_HOME: join(sdk, 'ndk', ndk) } },
  );
  for (const abi of androidAbis) binaries[`libsyncline_native-${abi}.so`] = join(android, abi, 'libsyncline_native.so');
  buildWasm('web');
  for (const file of webFiles) binaries[file] = join(workspace, 'target/web', file);
  return binaries;
}

/** The package.json version outside releases; no release ever carries it. */
const unreleased = '0.0.0';

/**
 * Writes `version` and the digests of its binaries into the package at `tree`, where an install reads both (src/prebuilt.mjs), and
 * returns the files written.
 */
export function stamp(tree: string, version: string, digests: Record<string, string>) {
  const manifest = join(tree, 'package.json');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^ {2}"version": "[^"]+",$/m, `  "version": "${version}",`));
  writeFileSync(join(tree, digestsFile), `${JSON.stringify(digests, null, 2)}\n`);
  return ['package.json', digestsFile];
}

function setVersion(version: string, digests: Record<string, string>, message: string) {
  run('git', ['commit', '-m', message, '--', ...stamp(root, version, digests)]);
}

const gh = (...args: string[]) => execFileSync('gh', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * Merges the tag into `main` through a pull request, then points the local `main` at the result. Waits for no CI: the tag and its
 * binaries are already public, and installs resolve tags, so CI on the pull request could keep `main` behind but never stop a release.
 */
function merge(tag: string) {
  const branch = `release/${tag}`;
  run('git', ['push', 'origin', `${tag}^{commit}:refs/heads/${branch}`]);
  const url = gh(
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    branch,
    '--title',
    `chore: release ${tag}`,
    '--body',
    `Merges ${tag} into main.`,
  );
  // A merge commit, unlike squashing or rebasing, keeps the tagged commit in main's history; main's tree is the tag's, as main is
  // always an ancestor of the tag or holds the previous tag's tree. Matching the head keeps anything pushed to the branch out of main.
  run('gh', ['pr', 'merge', url, '--merge', '--match-head-commit', git('rev-parse', `${tag}^{commit}`)]);
  run('git', ['fetch', 'origin', 'main']);
  // gh exits 0 without merging when main has a merge queue.
  run('git', ['merge-base', '--is-ancestor', tag, 'origin/main']);
  run('git', ['branch', '--force', 'main', 'origin/main']);
}

/**
 * Throws unless main's rules let a release merge at once: a pull request with no required approval and merge commits only (a squash or
 * rebase, even by hand, leaves main's history without the tag, so a later release's merge can keep old content), no required checks
 * (the merge waits for none), and no linear history.
 */
function mergeable() {
  type Rule = { type: string; parameters?: Record<string, unknown> };
  const rules = JSON.parse(gh('api', 'repos/{owner}/{repo}/rules/branches/main')) as Rule[];
  const request = rules.find((rule) => rule.type === 'pull_request')?.parameters;
  const methods = request?.allowed_merge_methods as string[] | undefined;
  if (
    request?.required_approving_review_count !== 0 ||
    request.require_code_owner_review ||
    methods?.join() !== 'merge' ||
    rules.some((rule) => rule.type === 'required_status_checks' || rule.type === 'required_linear_history')
  ) {
    throw new Error(
      'Protect main with a ruleset requiring pull requests (no approvals, merge commits only), without required checks or linear history',
    );
  }
}

function release(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version === unreleased) throw new Error(`Expected a version like 0.1.0, got ${version}`);
  if (git('branch', '--show-current') !== 'dev') throw new Error('Release from the dev branch');
  if (git('status', '--porcelain')) throw new Error('Release from a clean working tree');
  const tag = `v${version}`;
  // Checked before anything is tagged: pushing the tag without a release would leave it pointing at missing binaries, and a release main
  // cannot take would leave main on the previous release.
  run('gh', ['auth', 'status']);
  mergeable();
  run('pnpm', ['audit', '--prod', '--audit-level', 'high']);
  run('pnpm', ['check']);
  const packed = mkdtempSync(join(tmpdir(), 'syncline-release-'));
  const { assets, digests } = pack(packed, build());
  setVersion(version, digests, `chore: release ${tag}`);
  run('git', ['tag', tag]);
  // dev goes back to a version never released, so installing it or one of its commits fails asking for a release tag instead of pairing
  // its JavaScript with this release's binaries.
  setVersion(unreleased, {}, `chore: reset the version after releasing ${tag}`);
  run('git', ['push', '--atomic', 'origin', 'dev', `refs/tags/${tag}`]);
  try {
    run('gh', ['release', 'create', tag, '--verify-tag', '--title', tag, '--generate-notes', ...assets]);
  } catch (error) {
    // The pushed tag records the digests of these files, and a rebuild need not produce the same bytes.
    throw new Error(
      `${tag} is pushed, but its binaries are not all attached: attach the files in ${packed} (gh release upload ${tag} ${packed}/* --clobber once the release exists), then merge ${tag} into main through a pull request`,
      { cause: error },
    );
  }
  try {
    merge(tag);
  } catch (error) {
    throw new Error(
      `${tag} and its GitHub Release are published, but main did not take it: merge its pull request (gh pr merge release/${tag} --merge), then run git fetch origin main && git branch --force main origin/main`,
      { cause: error },
    );
  }
}

if (import.meta.main) release(process.argv[2] ?? '');
