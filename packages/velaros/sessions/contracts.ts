/**
 * 可移植数据入口（`@velaros-ai/velaros/sessions/contracts`）：错误码与三种工作区，以及 `velaros:sessions` 的入参与结果。
 * 还有 `velaros:sessions` 随包发布的模型面（`VelarSessionsModule`：模块名、方法、生成的完整声明、代码模版），宿主挂它时交给代码面的门。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarSessionsModule } from './contract/surface.js'
export type * from './types/sessions.js'
