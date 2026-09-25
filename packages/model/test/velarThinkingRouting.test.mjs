/**
 * @test-meta
 * title: Velar 思考深度路由提示
 * summary: 模型运行时 · 将 Composer 思考档位写入 Velar Cloud 请求的 reasoning 提示。
 * area: package
 */
import { describe, expect, test } from 'bun:test'

import { injectVelarThinkingRouting } from '../src/utils/wire/reasoning.ts'

describe('Velar thinking routing', () => {
  test.each([
    // 没给力度按 medium 发，与输入框的默认档一致。
    [undefined, { effort: 'medium' }],
    ['low', { effort: 'low' }],
    ['medium', { effort: 'medium' }],
    ['high', { effort: 'high' }],
    // 请求体没带 max_tokens 时 ultra 走 ultraFloor；带了就按 ultraRatio 换算（见 reasoning-level-ultra）。
    ['ultra', { effort: 'high', max_tokens: 16_000 }],
  ])('maps level=%s', (level, expected) => {
    const result = injectVelarThinkingRouting(
      { method: 'POST', body: JSON.stringify({ model: 'velaros/auto', messages: [] }) },
      level
    )
    const body = JSON.parse(result.body)

    expect(body.reasoning).toEqual(expected)
  })
})
