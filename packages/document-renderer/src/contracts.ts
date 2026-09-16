/**
 * 可移植数据入口（`@velaros-ai/document-renderer/contracts`）：命令协议的约定常量与回执数据类型。
 * 整条引用链不碰 Node 模块，只想按协议拼请求、读回执的调用方引它就够，不必拉起渲染实现。
 */
export * from './contract/constants.js'
export type * from './types/document-renderer.js'
