/**
 * 文件的本机实现入口（`@velaros-ai/velar/files/local`），只给 Node 宿主：本机文件端口（任意位置、原子替换写入，系统空间给 `velar:files` 用它）
 * 与本机全局搜索（按路径名或内容搜一棵目录树，给宿主界面用）。它们的接口与配置从根入口取。
 */

export { createLocalFilePort } from './impl/LocalFilePort.js'
export { createLocalFileSearch } from './impl/LocalFileSearch.js'
