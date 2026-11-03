// Wraps integrator Metro config: on web, Syncline's dedicated Worker loads device wasm compiled from Rust;
// wasm is bundled as an asset fetched by URL; Metro compiles it on startup (src/build-wasm.mjs, cargo compiles incrementally).
// Other tools also load Metro configs (e.g. knip finding entries), so compilation output is captured and surfaced only on error.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

/** Wraps an integrator's Metro configuration to compile and bundle Syncline web wasm assets. @param {import('expo/metro-config').MetroConfig} config */
exports.withSyncline = (config) => {
  try {
    execFileSync(process.execPath, [join(__dirname, 'src/build-wasm.mjs')], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to compile Syncline wasm:\n${error.stderr}`, { cause: error });
  }
  config.resolver.assetExts.push('wasm');
  return config;
};
