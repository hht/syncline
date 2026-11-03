// Declares asset URL export for wasm bundles packaged by Metro via withSyncline assetExts.
declare module '*.wasm' {
  const url: string;
  export default url;
}
