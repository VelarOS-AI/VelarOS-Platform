/**
 * 可移植数据入口（`@velaros-ai/velaros/browser/contracts`）：常量表与 `types/browser.ts` 的数据类型——`velaros:browser`、`velaros:devtools`、`velaros:cdp`
 * 的入参与回执、经空间端口流动的全部数据；还有随包发布的三件模型面（`VelarBrowserModule`、`VelarDevtoolsModule`、`VelarCdpModule`：模块名、方法、
 * 生成的完整声明与代码模版），空间挂它们时交给代码面的门。
 *
 * 不 import Node 内置模块，也不 import 任何实现：浏览器、渲染进程、工作线程、IPC 契约与测试都可以直接加载。
 */
export * from './contract/constants.js'
export { VelarBrowserModule, VelarCdpModule, VelarDevtoolsModule } from './contract/surface.js'
export type * from './types/browser.js'
