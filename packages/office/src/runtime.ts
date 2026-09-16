/** 运行时入口（`@velaros-ai/office/runtime`）：MarkItDown 定位器，宿主的插件目录用它判断装没装。 */
export type { MarkItDownLocatorApi } from './contract/provides.js'
export type { MarkItDownLocatorOptions, OfficeResourcePort } from './contract/requires.js'
export { createMarkItDownLocator, markItDownBinaryResolver } from './impl/runtime/MarkItDownLocator.js'
export type { MarkItDownLaunchSpec } from './types/office.js'
