/**
 * 渲染进程的目录入口（`@velaros-ai/model/catalog`）：可移植数据加一份模型目录实例。
 *
 * 根入口的装配链带 `node:vm` / `node:fs`，渲染进程加载不了；设置页与聊天页要的
 * 「这个 provider 有哪些模型、推荐哪个、回退到哪个、Ollama 地址怎么算」都在 `modelCatalog` 上。
 */
export * from './contracts.js'
export { modelCatalog } from './impl/providers/ModelCatalog'
