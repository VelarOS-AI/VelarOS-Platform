export interface ModelPricingEntry {
  provider: string
  model: string
  aliases: readonly string[]
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  /** 命中提示缓存的输入单价；缺席时约价把缓存读按 `inputUsdPerMillion` 计（偏高的上界）。 */
  cacheReadUsdPerMillion?: LooseOptional<number>
  /** 写入提示缓存的输入单价；缺席时约价把缓存写按 `inputUsdPerMillion` 计。 */
  cacheWriteUsdPerMillion?: LooseOptional<number>
  source: string
}

export interface ModelPricingCatalog {
  currency: 'USD'
  version: string
  updatedAt: string
  expiresAt: string
  entries: readonly ModelPricingEntry[]
}
