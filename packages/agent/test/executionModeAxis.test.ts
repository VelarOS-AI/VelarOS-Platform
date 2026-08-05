/**
 * 执行模式轴（`executionModes`）与能力轴（`promptFeatures`）拆分后的迁移与不变量电池。
 *
 * 锁四件事：
 *  ① **存量形态读入即迁移**：磁盘/旧宿主的 `promptFeatures:['plan']` 与 `goalMode:true`
 *     折算进模式轴，同时从能力轴剥除；不写回磁盘（读时迁移），降级回旧版本仍可读。
 *  ② **并集不是覆盖**：拆轴期两种形态会共存于同一条链路，覆盖会让其中一半静默消失。
 *  ③ **幂等**：两种形态一致时，折算结果与任一单独形态逐字相同（可反复过同一个解析器）。
 *  ④ **模式在场即 operational**：plan 不再靠「promptFeatures 非空」这条能力判据顺带命中阶段判定。
 */
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { resolveAgentContextPhase } from '../src/agent/ContextPhase'
import { resolveChatSendRequestOptions } from '../src/chat/resolveChatSendRequest'
import { resolveStoredChatSessionFields } from '../src/chat/resolveStoredChatSession'
import {
  isExecutionModeActive,
  normalizeExecutionModes,
  resolveExecutionModes,
  stripExecutionModePromptFeatures,
} from '../src/execution-modes'

void describe('模式轴归一', () => {
  void test('未知 id 静默丢弃、去重、按注册表声明序排', () => {
    assert.deepEqual(normalizeExecutionModes(['plan', 'plan', 'goal', 'nope', 7, null]), [
      'goal',
      'plan',
    ])
  })

  void test('能力轴剥除只针对模式的旧形态 id', () => {
    assert.deepEqual(stripExecutionModePromptFeatures(['plan', 'office', 'html-artifact']), [
      'office',
      'html-artifact',
    ])
  })
})

void describe('兼容折算：旧形态 → 模式轴', () => {
  void test('promptFeatures 里的 plan 折进模式轴', () => {
    assert.deepEqual(resolveExecutionModes({ promptFeatures: ['plan', 'office'] }), ['plan'])
  })

  void test('goalMode 布尔折进模式轴', () => {
    assert.deepEqual(resolveExecutionModes({ goalMode: true }), ['goal'])
  })

  void test('新轴与旧形态取并集，不是覆盖', () => {
    assert.deepEqual(
      resolveExecutionModes({
        executionModes: ['plan'],
        goalMode: true,
      }),
      ['goal', 'plan']
    )
  })

  void test('幂等：一致的两种形态折算结果与任一单独形态相同', () => {
    const once = resolveExecutionModes({ promptFeatures: ['plan'] })
    const twice = resolveExecutionModes({ executionModes: once, promptFeatures: ['plan'] })

    assert.deepEqual(twice, once)
    assert.deepEqual(resolveExecutionModes({ executionModes: twice }), once)
  })
})

void describe('存量会话读入迁移（磁盘 → 运行态）', () => {
  void test('旧会话的 plan 能力 + goalMode 布尔一起进模式轴，能力轴被剥干净', () => {
    const restored = resolveStoredChatSessionFields({
      goalMode: true,
      promptFeatures: ['plan', 'office'],
    })

    assert.deepEqual(restored.executionModes, ['goal', 'plan'])
    assert.deepEqual(restored.promptFeatures, ['office'])
    assert.equal(restored.goalMode, true)
  })

  void test('新会话直接读 executionModes，不依赖任何旧形态', () => {
    const restored = resolveStoredChatSessionFields({
      executionModes: ['plan'],
      promptFeatures: ['office'],
    })

    assert.deepEqual(restored.executionModes, ['plan'])
    assert.equal(restored.goalMode, false)
    assert.deepEqual(restored.promptFeatures, ['office'])
  })

  void test('纯聊天模式清空两根轴', () => {
    const restored = resolveStoredChatSessionFields({
      pureChatMode: true,
      goalMode: true,
      executionModes: ['plan'],
      promptFeatures: ['office'],
    })

    assert.deepEqual(restored.executionModes, [])
    assert.deepEqual(restored.promptFeatures, [])
    assert.equal(restored.goalMode, false)
  })

  void test('坏的 goalMode 仍按 VALIDATION 抛，不静默当 false', () => {
    assert.throws(() =>
      resolveStoredChatSessionFields({ goalMode: 'yes' as unknown as boolean })
    )
  })

  void test('纯聊天会话不读 goalMode——一格用不到的坏布尔不许砖化会话加载', () => {
    assert.doesNotThrow(() =>
      resolveStoredChatSessionFields({
        pureChatMode: true,
        goalMode: 'yes' as unknown as boolean,
      })
    )
  })
})

void describe('chat:send 解析口（宿主请求 → 运行态）', () => {
  void test('旧宿主只传 promptFeatures:[plan] 时计划模式照常成立，且不再污染能力轴', () => {
    const resolved = resolveChatSendRequestOptions({
      sessionId: 's-1',
      messages: [],
      promptFeatures: ['plan', 'office'],
    })

    assert.deepEqual(resolved.executionModes, ['plan'])
    assert.deepEqual(resolved.promptFeatures, ['office'])
    assert.equal(isExecutionModeActive('plan', resolved.executionModes), true)
  })

  void test('goalMode 由模式轴派生，两个入口给出同一答案', () => {
    const viaLegacy = resolveChatSendRequestOptions({
      sessionId: 's-1',
      messages: [],
      goalMode: true,
    })
    const viaAxis = resolveChatSendRequestOptions({
      sessionId: 's-1',
      messages: [],
      executionModes: ['goal'],
    })

    assert.equal(viaLegacy.goalMode, true)
    assert.equal(viaAxis.goalMode, true)
    assert.deepEqual(viaLegacy.executionModes, viaAxis.executionModes)
  })

  void test('纯聊天模式压平两根轴', () => {
    const resolved = resolveChatSendRequestOptions({
      sessionId: 's-1',
      messages: [],
      pureChatMode: true,
      goalMode: true,
      executionModes: ['plan'],
      promptFeatures: ['office'],
    })

    assert.deepEqual(resolved.executionModes, [])
    assert.deepEqual(resolved.promptFeatures, [])
  })
})

void describe('阶段判定按模式轴，不再蹭能力判据', () => {
  const firstTurn = { turn: 1, history: [{ role: 'user' as const, content: '你好' }] }

  void test('计划模式在场即 operational，理由是 execution-mode', () => {
    assert.deepEqual(resolveAgentContextPhase({ ...firstTurn, executionModes: ['plan'] }), {
      phase: 'operational',
      reason: 'execution-mode',
    })
  })

  void test('目标模式的旧布尔入口给出同一判定', () => {
    assert.deepEqual(resolveAgentContextPhase({ ...firstTurn, goalMode: true }), {
      phase: 'operational',
      reason: 'execution-mode',
    })
  })

  void test('没有模式也没有能力时仍走 bootstrap', () => {
    assert.equal(resolveAgentContextPhase(firstTurn).phase, 'bootstrap')
  })
})
