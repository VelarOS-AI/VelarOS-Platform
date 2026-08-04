/**
 * 历史结构自愈的护栏测试（`history/repair.ts`）。
 *
 * 这条路径是"4 次 mid-tool-call 中止 0 brick"的唯一保障：流中止 / 异常会在持久历史里留下孤儿
 * tool-result 或缺结果的 tool-call 组，若不修复，此后每次 send 都被 `assertValidModelHistory`
 * 拦下，会话被永久锁死。逻辑随上下文治理 v2 从死掉的 `history/compaction.ts` 平移到 `repair.ts`，
 * 本文件把"损坏历史 → 修复 → provider 校验通过"钉成断言。
 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { repairHistoryStructureForProvider } from '../src/agent/history/repair'
import { assertValidModelHistory, validateModelHistory } from '../src/agent/history/validate'

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text }
}

function assistantToolCall(calls: Array<{ id: string; name: string }>): ModelMessage {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'tool-call' as const,
      toolCallId: call.id,
      toolName: call.name,
      input: {},
    })),
  }
}

function toolResults(results: Array<{ id: string; name: string; value: string }>): ModelMessage {
  return {
    role: 'tool',
    content: results.map((result) => ({
      type: 'tool-result' as const,
      toolCallId: result.id,
      toolName: result.name,
      output: { type: 'text' as const, value: result.value },
    })),
  }
}

function expectProviderValid(history: ModelMessage[]): void {
  const validation = validateModelHistory(history)
  assert.equal(
    validation.valid,
    true,
    `修复后的历史仍不满足 provider 校验: ${JSON.stringify(validation.issues)}`
  )
  // 与真实送核路径同一入口（除结构外还查收尾角色）。
  assertValidModelHistory([...history, userMessage('继续')], { phase: 'stream', turn: 1 })
}

describe('history structure repair', () => {
  test('孤儿 tool-result 消息（无前驱 tool-call）被丢弃，修复后可送核', () => {
    const broken: ModelMessage[] = [
      userMessage('读一下配置'),
      // 中止把 assistant 的 tool-call 消息吞了，只剩结果。
      toolResults([{ id: 'call-orphan', name: 'read_file', value: 'orphan payload' }]),
      userMessage('继续'),
    ]
    assert.equal(validateModelHistory(broken).valid, false)

    const repaired = repairHistoryStructureForProvider(broken)

    assert.ok(repaired.removedMessages + repaired.changedMessages > 0)
    assert.equal(
      repaired.history.some((message) => message.role === 'tool'),
      false
    )
    expectProviderValid(repaired.history)
  })

  test('缺结果的 tool-call 组被回填「被中断」占位结果，修复后可送核', () => {
    const broken: ModelMessage[] = [
      userMessage('跑两个工具'),
      assistantToolCall([
        { id: 'call-a', name: 'read_file' },
        { id: 'call-b', name: 'run_command' },
      ]),
      // 中止发生在第二个工具返回之前。
      toolResults([{ id: 'call-a', name: 'read_file', value: 'ok' }]),
    ]
    assert.equal(validateModelHistory(broken).valid, false)

    const repaired = repairHistoryStructureForProvider(broken)

    assert.equal(repaired.issues[0]?.kind, 'missing-tool-results')
    assert.deepEqual(repaired.issues[0]?.missingToolCallIds, ['call-b'])
    // 回填而不是整组移除：assistant 的 tool-call 消息必须留在历史里。
    assert.equal(
      repaired.history.some((message) => message.role === 'assistant'),
      true
    )
    expectProviderValid(repaired.history)
  })

  test('混在合法结果里的孤儿 tool-result 片段被逐片剥除，同组合法结果保留', () => {
    const broken: ModelMessage[] = [
      userMessage('读一下配置'),
      assistantToolCall([{ id: 'call-a', name: 'read_file' }]),
      toolResults([
        { id: 'call-a', name: 'read_file', value: 'ok' },
        // 上一轮中止残留、与本组合法结果混在同一条 tool 消息里的孤儿片段。
        { id: 'call-ghost', name: 'read_file', value: 'ghost payload' },
      ]),
    ]
    assert.equal(validateModelHistory(broken).valid, false)

    const repaired = repairHistoryStructureForProvider(broken)

    assert.ok(repaired.changedMessages > 0)
    const toolMessage = repaired.history.find((message) => message.role === 'tool')
    assert.ok(Array.isArray(toolMessage?.content))
    assert.deepEqual(
      (toolMessage.content as Array<{ toolCallId?: string }>).map((part) => part.toolCallId),
      ['call-a']
    )
    expectProviderValid(repaired.history)
  })

  test('结构完好的历史原样返回（零改动、零移除）', () => {
    const healthy: ModelMessage[] = [
      userMessage('读一下配置'),
      assistantToolCall([{ id: 'call-a', name: 'read_file' }]),
      toolResults([{ id: 'call-a', name: 'read_file', value: 'ok' }]),
    ]

    const repaired = repairHistoryStructureForProvider(healthy)

    assert.equal(repaired.removedMessages, 0)
    assert.equal(repaired.changedMessages, 0)
    expectProviderValid(repaired.history)
  })

  test('空工具名调用及其结果按组移除，不会锁死后续对话', () => {
    const broken = [
      userMessage('读取笔记'),
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-empty-name',
            toolName: '',
            input: { path: 'notes.txt' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-empty-name',
            toolName: '',
            output: { type: 'error-text', value: 'tool not found' },
          },
        ],
      },
    ] as ModelMessage[]
    assert.equal(validateModelHistory(broken).valid, false)

    const repaired = repairHistoryStructureForProvider(broken)

    assert.ok(repaired.removedMessages > 0)
    assert.equal(repaired.history.length, 1)
    expectProviderValid(repaired.history)
  })

  test('混合正文中的残缺工具块被移除，正文仍可回放', () => {
    const broken = [
      userMessage('继续'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先检查文件。' },
          {
            type: 'tool-call',
            toolCallId: 'call-partial',
            toolName: '   ',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-partial',
            toolName: '   ',
            output: { type: 'error-text', value: 'invalid identity' },
          },
        ],
      },
    ] as ModelMessage[]

    const repaired = repairHistoryStructureForProvider(broken)

    assert.deepEqual(repaired.history, [
      userMessage('继续'),
      { role: 'assistant', content: [{ type: 'text', text: '我先检查文件。' }] },
    ])
    expectProviderValid(repaired.history)
  })
})
