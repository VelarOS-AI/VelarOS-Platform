import type { ChatPromptFeatureId } from '../types'

/**
 * Kernel treats prompt-feature ids as opaque host capability ids.
 *
 * Concrete manifests, labels, category mappings, availability policy, and tool
 * gates are owned by capability packages and injected into Agent Runtime.
 */
export function normalizePromptFeatures(
  features: readonly ChatPromptFeatureId[] = []
): ChatPromptFeatureId[] {
  return [...new Set(features.filter((feature) => feature.trim()))]
}
