// 候选单价必须绑定同一模型与推理参数；缺席时保留未知费用。
export function validateCandidatePricing(value, modelName, reasoningEffort) {
  const rates = [
    'input',
    'cachedInput',
    'cacheWriteInput',
    'output',
    'longThreshold',
    'longInputMultiplier',
    'longOutputMultiplier',
  ]
  if (
    !value ||
    typeof value !== 'object' ||
    value.schema !== 1 ||
    value.model !== modelName ||
    value.reasoning_effort !== reasoningEffort ||
    value.unit !== 'USD per million tokens' ||
    rates.some((key) => !Number.isFinite(value[key]) || value[key] < 0) ||
    ['service_tier', 'source', 'verified_at'].some(
      (key) => typeof value[key] !== 'string' || !value[key]
    )
  )
    throw new Error(
      'Pricing must be complete, finite and frozen for this model and reasoning effort'
    )
  return value
}
