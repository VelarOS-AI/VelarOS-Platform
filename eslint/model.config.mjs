// VelarOS-Model eslint 配置。
//
// QH 批门覆盖审计实测:本域此前比 core / agent / kernel / capabilities 少 44 条规则——整个
// unicorn 族、simple-import-sort 族、velaros-style 族、eslint-comments 族、以及 no-console /
// prefer-const / no-var / object-shorthand 等基础条目全部缺席,只跑 js 推荐 + tsPlugin 推荐。
// 这不是本域有意从宽,是并仓时搬进来的源仓配置本身就没配过。现改为引用共享基座
// eslint/_shared.config.mjs,并把源仓原有的 tsPlugin recommended 保留为基座(只增不减)。
import tsPlugin from '@typescript-eslint/eslint-plugin'

import { createDomainConfig } from './_shared.config.mjs'

export default createDomainConfig({
  rootDir: import.meta.dirname,
  // 源仓原有的 tsPlugin recommended:铺在共享规则之前,只补 ban-ts-comment / no-namespace /
  // no-this-alias 等共享集没有的条目,不覆盖共享判决。
  tsRulesBase: tsPlugin.configs.recommended.rules,
  // 未用变量的判决由 unused-imports/no-unused-vars 单源承担(共享集已开),关掉重复的一条。
  tsRules: { '@typescript-eslint/no-unused-vars': 'off' },
  declarationRules: {
    '@typescript-eslint/triple-slash-reference': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
  },
})
