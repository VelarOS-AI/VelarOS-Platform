// VelarOS-Memory eslint 配置。
//
// QH 批门覆盖审计实测:本域此前比 core / agent / kernel / capabilities 少 28 条规则
// (velaros-style 两条、@typescript-eslint 八条、no-lonely-if / prefer-template / one-var /
// unicorn 五条 / unused-imports/no-unused-vars …)——不是本域有意从宽,是并仓时搬进来的
// 源仓配置本来就是个子集,复制七份之后没人看得出差异。现改为引用共享基座 eslint/_shared.config.mjs,
// 规则集与其余域同源;域私有的只剩 ignores 与一条 prefer-as-const。
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDomainConfig } from './_shared.config.mjs'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default createDomainConfig({
  rootDir,
  ignores: ['tests/**'],
  // 源仓自带、其余域没有的一条:保留。
  tsRules: { '@typescript-eslint/prefer-as-const': 'error' },
})
