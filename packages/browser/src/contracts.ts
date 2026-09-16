/**
 * `@velaros-ai/browser/contracts`：可移植数据与约定的常量表。
 *
 * 只有 `types/browser.ts` 的数据类型与 `contract/constants.ts` 的常量表——不 import Node 内置模块，
 * 也不 import 任何实现。浏览器、渲染进程、工作线程、IPC 契约与测试都可以直接加载。
 */
export * from './contract/constants.js'
export type * from './types/browser.js'
