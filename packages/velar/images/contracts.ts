/**
 * 可移植数据入口（`@velaros-ai/velar/images/contracts`）：公开上限，以及 `velar:images` 的入参与结果。
 * 还有 `velar:images` 随包发布的模型面（`VelarImagesModule`：模块名、方法、生成的完整声明），空间挂它时交给代码面的门。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarImagesModule } from './contract/surface.js'
export type * from './types/images.js'
