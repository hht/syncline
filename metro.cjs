// Wraps integrator Metro config: on web, Syncline's dedicated Worker loads device wasm compiled from Rust; wasm is bundled as an asset
// fetched by URL. On startup, a checkout of this repository compiles it (rust/wasm/build.mjs, cargo compiles incrementally); installs carry
// no Rust sources and download the release's build (src/prebuilt.mjs) to where the compile would write it.
// Other tools also load Metro configs (e.g. knip finding entries), so output is captured and surfaced only on error.
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

/** Wraps an integrator's Metro configuration to build or download and bundle Syncline web wasm assets. @param {import('expo/metro-config').MetroConfig} config */
exports.withSyncline = (config) => {
  const args = existsSync(join(__dirname, 'rust/Cargo.toml'))
    ? [join(__dirname, 'rust/wasm/build.mjs')]
    : [
        join(__dirname, 'src/prebuilt.mjs'),
        ...['syncline_wasm.js', 'syncline_wasm.d.ts', 'syncline_wasm_bg.wasm'].flatMap((file) => [
          file,
          join(__dirname, 'rust/target/web', file),
        ]),
      ];
  try {
    execFileSync(process.execPath, args, { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to prepare Syncline wasm:\n${error.stderr}`, { cause: error });
  }
  config.resolver.assetExts.push('wasm');
  return config;
};
