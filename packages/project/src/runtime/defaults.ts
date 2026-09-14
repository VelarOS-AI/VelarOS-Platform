export { DEFAULT_CORE_POLICY } from '../policy/defaults.js'

// 与 package.json#version 手工同步，由 check:arch 机械对齐（漂移即红）。
// 留字面量而不从 package.json 读：本包会被打进消费方 bundle，ESM 里 import JSON 要
// resolveJsonModule + 打包器配合，代价大于一条门；而这条门刚抓到过一次真实漂移，说明它够用。
export const PROJECT_PACKAGE_VERSION = '2.1.0'
