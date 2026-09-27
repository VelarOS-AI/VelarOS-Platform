/**
 * 可移植数据入口（`@velaros-ai/velaros/web/contracts`）：错误码与公开上限，以及 `velaros:web` 的入参与结果。
 * 还有 `velaros:web` 随包发布的模型面（`VelarWebModule`：模块名、方法、生成的完整声明、代码模版），宿主挂它时交给代码面的门。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarWebModule } from './contract/surface.js'
export type * from './types/web.js'
