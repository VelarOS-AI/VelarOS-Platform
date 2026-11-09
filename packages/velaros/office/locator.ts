/** 本机 MarkItDown 资源定位入口；不加载文档生成、PDF、Canvas 或字体运行时。 */
export type { MarkItDownLocatorApi } from './contract/provides.js'
export type { MarkItDownLocatorOptions, OfficeResourcePort } from './contract/requires.js'
export { createMarkItDownLocator } from './impl/runtime/MarkItDownLocator.js'
export type { MarkItDownLaunchSpec } from './types/office.js'
