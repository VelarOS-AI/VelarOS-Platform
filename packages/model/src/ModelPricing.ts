export interface ModelPricingEntry {
  provider: string
  model: string
  aliases: readonly string[]
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  source: string
}

export interface ModelPricingCatalog {
  currency: 'USD'
  version: string
  updatedAt: string
  expiresAt: string
  entries: readonly ModelPricingEntry[]
}
