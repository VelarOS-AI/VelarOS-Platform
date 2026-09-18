/**
 * 可移植数据入口（`@velaros-ai/project/contracts`）：项目空间的常量表。没有任何 Node 依赖，浏览器、渲染进程都能 import。
 * 宿主端口本身是注入面，从根入口取；两件项目工具的可移植数据在 `@velaros-ai/velar/project/contracts`。
 */
export * from './contract/constants.js'
