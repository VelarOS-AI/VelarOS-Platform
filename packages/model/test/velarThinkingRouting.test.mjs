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
    // velaros/auto 看不出是哪家，超过 high 的档退到 high（见 reasoning-levels）。
    ['xhigh', { effort: 'high' }],
    ['max', { effort: 'high' }],
  ])('maps level=%s', (level, expected) => {
    const result = injectVelarThinkingRouting(
      { method: 'POST', body: JSON.stringify({ model: 'velaros/auto', messages: [] }) },
      level
    )
    const body = JSON.parse(result.body)

    expect(body.reasoning).toEqual(expected)
  })
})
