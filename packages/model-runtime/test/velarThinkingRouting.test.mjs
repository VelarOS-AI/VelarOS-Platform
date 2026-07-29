/**
 * @test-meta
 * title: Velar 思考深度路由提示
 * summary: 模型运行时 · 将 Composer 思考档位写入 Velar Cloud 请求的 reasoning 提示。
 * area: package
 */
import { describe, expect, test } from 'bun:test'

import { injectVelarThinkingRouting } from '../src/VelarModelAdapter.ts'

describe('Velar thinking routing', () => {
  test.each([
    ['fast', undefined, { effort: 'low' }],
    ['balanced', undefined, { effort: 'medium' }],
    ['deep', undefined, { effort: 'high' }],
    ['balanced', 'off', { enabled: false, exclude: true }],
    ['balanced', 'low', { effort: 'low' }],
    ['balanced', 'medium', { effort: 'medium' }],
    ['balanced', 'high', { effort: 'high' }],
    ['balanced', 'ultra', { effort: 'high', max_tokens: 24_000 }],
  ])('maps depth=%s level=%s', (depth, level, expected) => {
    const result = injectVelarThinkingRouting(
      { method: 'POST', body: JSON.stringify({ model: 'velar/auto', messages: [] }) },
      depth,
      level
    )
    const body = JSON.parse(result.body)

    expect(body.reasoning).toEqual(expected)
  })
})
