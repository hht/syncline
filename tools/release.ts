import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildWasm } from '../src/build-wasm.mjs';

/**
 * Publishes a release (`pnpm release <version>`): from a clean `dev` that passes `pnpm check`, builds the device binaries, commits the version
 * and tags it, resets `dev` to the unreleased version, pushes `dev` and the tag, attaches the gzipped binaries and their manifest to a GitHub Release on the tag, and only then
 * merges the tag into `main` through a pull request, which takes only pull requests, so `main` always installs a release whose binaries
 * exist. Installs download the binaries with src/prebuilt.mjs. The binaries build from the tagged tree except its package.json version,
 * which no build reads.
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
 * Gzips each binary into `dir` as `<asset>.gz` and writes manifest.json recording the version, commit, and each asset's SHA-256, which
 * src/prebuilt.mjs checks. Returns the paths to upload.
 */
export function pack(dir: string, binaries: Record<string, string>, version: string, commit: string) {
  const files: Record<string, string> = {};
  for (const [asset, path] of Object.entries(binaries)) {
    const body = gzipSync(readFileSync(path), { level: 9 });
    writeFileSync(join(dir, `${asset}.gz`), body);
    files[`${asset}.gz`] = createHash('sha256').update(body).digest('hex');
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ version, commit, files }, null, 2)}\n`);
  return [...Object.keys(files), 'manifest.json'].map((name) => join(dir, name));
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

function setVersion(version: string, message: string) {
  const manifest = join(root, 'package.json');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^ {2}"version": "[^"]+",$/m, `  "version": "${version}",`));
  run('git', ['commit', '-m', message, '--', 'package.json']);
}

const gh = (...args: string[]) => execFileSync('gh', args, { cwd: root, encoding: 'utf8' }).trim();

/** Check conclusions and status states that keep a pull request from merging until it is pushed again. */
const failed = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/** Merges the tag into `main` through a pull request once its required checks pass, then points the local `main` at the result. */
async function merge(tag: string) {
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
  run('gh', ['pr', 'merge', url, '--merge', '--auto', '--match-head-commit', git('rev-parse', `${tag}^{commit}`)]);
  for (;;) {
    const { state, statusCheckRollup } = JSON.parse(gh('pr', 'view', url, '--json', 'state,statusCheckRollup')) as {
      state: string;
      statusCheckRollup: { name?: string; context?: string; conclusion?: string; state?: string }[];
    };
    if (state === 'MERGED') break;
    const broken = statusCheckRollup.filter((check) => failed.has(check.conclusion ?? check.state ?? ''));
    if (state === 'CLOSED' || broken.length > 0) {
      const names = broken.map((check) => check.name ?? check.context).join(', ');
      throw new Error(
        `${url} did not merge (${names || state}); ${tag} and its GitHub Release are published: re-run the failed CI job, and auto-merge merges once it passes, or release a new version`,
      );
    }
    console.log(`Waiting for CI on ${url}`);
    await new Promise((done) => setTimeout(done, 30_000));
  }
  run('git', ['fetch', 'origin', 'main']);
  run('git', ['branch', '--force', 'main', 'origin/main']);
}

/**
 * Throws unless main's rules let a release merge on its own: a pull request with no required approval and merge commits only (a squash or
 * rebase, even by hand, leaves main's history without the tag, so a later release's merge can keep old content), and CI required without
 * requiring the branch to be up to date (a new tag never contains main's previous merge commit).
 */
function mergeable() {
  type Rule = { type: string; parameters?: Record<string, unknown> };
  const rules = JSON.parse(gh('api', 'repos/{owner}/{repo}/rules/branches/main')) as Rule[];
  const request = rules.find((rule) => rule.type === 'pull_request')?.parameters;
  const checks = rules.find((rule) => rule.type === 'required_status_checks')?.parameters;
  const methods = request?.allowed_merge_methods as string[] | undefined;
  if (
    !request ||
    !checks ||
    request.required_approving_review_count !== 0 ||
    request.require_code_owner_review ||
    methods?.join() !== 'merge' ||
    checks.strict_required_status_checks_policy ||
    rules.some((rule) => rule.type === 'required_linear_history')
  ) {
    throw new Error(
      'Protect main with a ruleset requiring pull requests (no approvals, merge commits only) and the CI check (branches need not be up to date), without linear history',
    );
  }
}

async function release(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version === unreleased) throw new Error(`Expected a version like 0.1.0, got ${version}`);
  if (git('branch', '--show-current') !== 'dev') throw new Error('Release from the dev branch');
  if (git('status', '--porcelain')) throw new Error('Release from a clean working tree');
  const tag = `v${version}`;
  // Checked before anything is tagged: pushing the tag without a release would leave it pointing at missing binaries, and a release main
  // cannot take (auto-merge off, no rule requiring CI, or a check CI runs beyond pnpm check) would leave main on the previous release.
  run('gh', ['auth', 'status']);
  if (gh('api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge') !== 'true')
    throw new Error('Allow auto-merge in the repository settings');
  mergeable();
  run('pnpm', ['audit', '--prod', '--audit-level', 'high']);
  run('pnpm', ['check']);
  const binaries = build();
  setVersion(version, `chore: release ${tag}`);
  run('git', ['tag', tag]);
  const assets = pack(mkdtempSync(join(tmpdir(), 'syncline-release-')), binaries, version, git('rev-parse', 'HEAD'));
  // dev goes back to a version never released, so installing it or one of its commits fails asking for a release tag instead of pairing
  // its JavaScript with this release's binaries.
  setVersion(unreleased, `chore: reset the version after releasing ${tag}`);
  run('git', ['push', '--atomic', 'origin', 'dev', `refs/tags/${tag}`]);
  run('gh', ['release', 'create', tag, '--verify-tag', '--title', tag, '--generate-notes', ...assets]);
  await merge(tag);
}

if (import.meta.main) await release(process.argv[2] ?? '');
