import { describe, expect, test } from 'bun:test'

import { estimateMessageCost } from '../src/conversation/blocks/messageCostEstimate'

describe('message cost model aliases', () => {
  for (const [source, canonical] of [
    ['claude-sonnet-4-5beta', 'claude-sonnet-4.5beta'],
    ['claude-sonnet-4-5:beta', 'claude-sonnet-4.5:beta'],
    ['claude-sonnet-4-5-beta', 'claude-sonnet-4.5-beta'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4.5-20250929'],
  ] as const) {
    test(`preserves the suffix while normalizing ${source}`, () => {
      const estimate = estimateMessageCost({
        provider: 'anthropic',
        model: source,
        question: 'question',
        answer: 'answer',
        pricingCatalog: {
          currency: 'USD',
          version: 'test',
          updatedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2027-01-01T00:00:00.000Z',
          entries: [{
            provider: 'anthropic',
            model: canonical,
            aliases: [],
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
            source: 'test',
          }],
        },
      })

      expect(estimate).not.toBeNull()
    })
  }
})
