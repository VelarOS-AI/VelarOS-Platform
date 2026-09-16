/**
 * 可移植数据入口（`@velaros-ai/cli/contracts`）：输出信封的约定常量、错误码、退出码、环境变量表与信封的数据形状。
 * 整条引用链不碰 Node 模块，渲染进程与浏览器里解析 `--json` 输出的代码都能 import。
 */
export * from './contract/constants.js'
export type * from './types/cli.js'
