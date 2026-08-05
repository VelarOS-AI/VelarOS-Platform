import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import {
  parseGuidanceRelayPlan,
  resolveMainAgentGuidanceDelivery,
  resolveMainAgentGuidanceMessage,
} from '../src/execution/GuidanceRelayPlanner'

const originalMessage: ModelMessage = { role: 'user', content: '顺便把 README 也更新一下' }

void describe('sub-agent guidance relay is a pure increment', () => {
  void test('a plan with relays and no mainAgent field still reaches the main agent', () => {
    // 回归：这是最常见的一条路径。旧实现要求遗留布尔 `notifyMainAgent` 为真才回消息，而提示词
    // 只教 mainAgent.mode，模型永远不会填它 → 主控恒收不到用户这句话。
    const plan = parseGuidanceRelayPlan({
      understanding: '用户想让 README 一起更新',
      relays: [{ threadId: 'thread-1', message: '记得同步 README' }],
    })

    assert.ok(resolveMainAgentGuidanceMessage(plan))
  })

  void test('the removed notifyMainAgent boolean can no longer suppress delivery', () => {
    const plan = parseGuidanceRelayPlan({
      understanding: '用户想让 README 一起更新',
      relays: [{ threadId: 'thread-1', message: '记得同步 README' }],
      notifyMainAgent: false,
    })

    assert.ok(resolveMainAgentGuidanceMessage(plan))
  })

  void test('mainAgent.mode "none" drops only the rewrite, never the user message', () => {
    const plan = parseGuidanceRelayPlan({
      understanding: '这句只与子任务有关',
      relays: [{ threadId: 'thread-1', message: '换个搜索词' }],
      mainAgent: { mode: 'none' },
    })

    const rewrite = resolveMainAgentGuidanceMessage(plan)
    assert.equal(rewrite, null)

    const delivery = resolveMainAgentGuidanceDelivery({
      plannedMainAgentMessage: rewrite,
      originalMessage,
    })
    assert.equal(delivery.kind, 'verbatim')
    assert.deepEqual(delivery.message, originalMessage)
  })

  void test('a blank understanding still delivers the raw user message', () => {
    const delivery = resolveMainAgentGuidanceDelivery({
      plannedMainAgentMessage: '   ',
      originalMessage,
    })

    assert.equal(delivery.kind, 'verbatim')
    assert.deepEqual(delivery.message, originalMessage)
  })

  void test('a planned rewrite replaces the raw message rather than adding a second one', () => {
    const delivery = resolveMainAgentGuidanceDelivery({
      plannedMainAgentMessage: '[主控补充] 用户想让 README 一起更新',
      originalMessage,
    })

    assert.equal(delivery.kind, 'planned-rewrite')
    assert.deepEqual(delivery.message, {
      role: 'user',
      content: '[主控补充] 用户想让 README 一起更新',
    })
  })
})
