/**
 * 可移植数据入口（`@velaros-ai/velar/browser/contracts`）：常量表与 `types/browser.ts` 的数据类型——`velar:browser`、`velar:devtools`
 * 的入参与回执、经空间端口流动的全部数据；还有随包发布的两件模型面（`VelarBrowserModule`、`VelarDevtoolsModule`：模块名、方法、
 * 生成的完整声明与代码模版），空间挂它们时交给代码面的门。
 *
 * 不 import Node 内置模块，也不 import 任何实现：浏览器、渲染进程、工作线程、IPC 契约与测试都可以直接加载。
 */
export * from './contract/constants.js'
export { VelarBrowserModule, VelarDevtoolsModule } from './contract/surface.js'
export type * from './types/browser.js'
