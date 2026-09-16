/**
 * 命令行根入口（`@velaros-ai/cli`）：进程壳、命令行路由器与它的扩展点，外加它们签名里用到的数据。
 * 装出来的 `velaros` 命令走 `bin/velaros.mjs`，这里只是库面；import 它不启动任何东西。
 * 另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 注入面：产品注册自己的运维命名空间 ───────────────────────────
export type { VelarosCliNamespaceRunner } from '../contract/requires.js'

// ── 产品面：进程壳 ──────────────────────────────────────────────
export type { VelarosCliProcessApi, VelarosCliProcessContext } from '../impl/VelarosCliProcess.js'
export { velarosCliProcess } from '../impl/VelarosCliProcess.js'

// ── 产品面：命令行路由器 ────────────────────────────────────────
export type { VelarosCliRouterApi, VelarosCliRouterOptions } from '../impl/VelarosCliRouter.js'
export { createVelarosCliRouter, velarosCli } from '../impl/VelarosCliRouter.js'
