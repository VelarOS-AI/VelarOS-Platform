/**
 * 可移植数据入口（`@velaros-ai/velar/sandbox/contracts`）：公开上限，与经过宿主端口流动的沙箱数据类型。
 * 还有 `velar:sandbox` 随包发布的模型面（`VelarSandboxModule`：模块名、方法、生成的完整声明），空间挂它时交给代码面的门。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarSandboxModule } from './contract/surface.js'
export type * from './types/rehearsal-sandbox.js'
