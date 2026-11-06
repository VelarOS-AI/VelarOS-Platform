/** 模型使用的能力管理模块身份。 */
export const FeaturesModuleId = 'velaros:features' as const

/** 能力定位与来源输入的公开边界。 */
export const FeatureLimits = Object.freeze({
  /** 能力身份最多字符数。 */
  idChars: 214,
  /** 本机来源路径最多字符数。 */
  pathChars: 4096,
})
