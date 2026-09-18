/**
 * `@velaros-ai/velar/browser/electron`：Electron 主进程要的三件值。
 *
 * 单开这个入口的唯一理由是运行环境：这条引用链值 import `electron`（可选 peer），
 * 放进根入口会让不装 Electron 的 Node 宿主一加载就失败。
 * 它们的类型（`ElectronBrowserRuntimeApi` 等）在根入口里也叫得出来。
 */
export {
  BrowserRuntimeCapability,
  createBrowserKernelModule,
  createElectronBrowserRuntime,
} from './impl/electron/ElectronBrowserRuntime.js'
