// 在 Metro 里用 Syncline（接入方的 metro.config.js 包一层）：web 上 Syncline 自带的 Worker 加载编成 wasm 的 Rust 设备，
// wasm 当资源打包、按网址取；Metro 起来时先把它编好（src/build-wasm.mjs，cargo 是增量编译，没改时一两秒）。
// 别的工具也会加载 Metro 配置（knip 找入口），编译的输出只在出错时带出来，不混进它们的输出
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

/** 包一层接入方的 Metro 配置 @param {import('expo/metro-config').MetroConfig} config */
exports.withSyncline = (config) => {
  try {
    execFileSync(process.execPath, [join(__dirname, 'src/build-wasm.mjs')], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`编 Syncline 的 wasm 失败：\n${error.stderr}`, { cause: error });
  }
  config.resolver.assetExts.push('wasm');
  return config;
};
