// VelarOS-HTML-Artifacts eslint 配置(QH 批新立)。
//
// 由来:该域的源仓不带 eslint 门,并仓时按「维持无门现状」整包写进了根 ignores——于是本域是
// Platform 唯一一个**一条 eslint 规则都不跑**的包(门覆盖审计实测 0/104)。「没挂链的门等于没有门,
// 还多骗一层安全感」,实测本域按共享规则集只有 16 条违规(全部机械可修),没有维持无门的理由。
//
// 扫描面只收源码与构建脚本;demo/ 与 tests/ 是示例与退役测试树,不进门。
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDomainConfig } from './_shared.config.mjs'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default createDomainConfig({
  rootDir,
  ignores: [
    'packages/html-artifacts/demo/**',
    'packages/html-artifacts/tests/**',
    'packages/html-artifacts/dist/**',
    'packages/html-artifacts/demo-dist/**',
  ],
})
