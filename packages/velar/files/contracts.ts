/**
 * 可移植数据入口（`@velaros-ai/velar/files/contracts`）：错误码与公开上限，以及 `velar:files` 的入参、结果与空间定位出来的路径。
 * 还有 `velar:files` 随包发布的模型面（`VelarFilesModule`：模块名、方法、生成的完整声明），空间挂它时交给代码面的门。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarFilesModule } from './contract/surface.js'
export type * from './types/files.js'
