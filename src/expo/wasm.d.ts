// Metro 把 wasm 当资源打包（withSyncline 把 wasm 加进 assetExts），导入得到它的网址；wasm-bindgen 生成的类型按 ES 模块写，tsc 也找不到它
declare module '*.wasm' {
  const url: string;
  export default url;
}
