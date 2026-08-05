/**
 * S4 接线面回归：分类器端口的「否决去重」第三态、迁移事件的账本代数、环境账本的实例代次。
 *
 * 三条都是宿主与 agent 包之间的**接缝**契约——坏掉时不会抛异常，只会静默丢内容
 * （去重吞掉同一文件的另一段 / 重放把两代账本的同名 id 混成一条 / 旧 cursor 吞掉重建后的 delta），
 * 所以每条都用机械断言钉住。
 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import {
  ContextDedupeVetoTarget,
  type ContextRecordClassifier,
} from '../src/agent/context/residency/admission'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import { InMemoryContextMigrationEventSink } from '../src/agent/context/residency/migrationLog'
import { ContextResidencyLedger } from '../src/agent/context/residency/ResidencyLedger'
import { TurnContextSessionLedgers } from '../src/agent/run-context/TurnContextLedger'

function toolCallMessage(toolCallId: string, toolName: string, input: unknown): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input }],
  } as ModelMessage
}

function toolResultMessage(toolCallId: string, toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value } }],
  } as ModelMessage
}

function appendToolResult(
  ledger: ContextResidencyLedger,
  input: { toolCallId: string; toolName: string; value: string; toolArgs: unknown; at: number }
): string {
  return ledger.append({
    kind: 'tool-result',
    message: toolResultMessage(input.toolCallId, input.toolName, input.value),
    toolArgs: input.toolArgs,
    createdAt: input.at,
    turn: 0,
  }).record.id
}

void describe('classifier port · dedupe veto (审计 U42/U24)', () => {
  test('弃权回落结构信号：同一绝对路径的两次分页读被判为同一目标', () => {
    const ledger = new ContextResidencyLedger()
    appendToolResult(ledger, {
      toolCallId: 'call-1',
      toolName: 'system:read',
      value: 'page one',
      toolArgs: { path: '/tmp/build.log', startLine: 1, endLine: 120 },
      at: 1,
    })
    const second = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-2', 'system:read', 'page two'),
      toolArgs: { path: '/tmp/build.log', startLine: 120, endLine: 240 },
      createdAt: 2,
      turn: 0,
    })

    assert.equal(second.record.dedupeKey, 'system:read::/tmp/build.log')
    assert.equal(second.supersededIds.length, 1, '弃权时结构信号会把上一页判成过时快照')
  })

  test('否决哨兵不回落结构信号：两次分页读互不取代', () => {
    const classifier: ContextRecordClassifier = {
      resolveDedupeTarget: (input) =>
        input.toolName === 'system:read' ? ContextDedupeVetoTarget : undefined,
    }
    const ledger = new ContextResidencyLedger({ classifier })
    appendToolResult(ledger, {
      toolCallId: 'call-1',
      toolName: 'system:read',
      value: 'page one',
      toolArgs: { path: '/tmp/build.log', startLine: 1, endLine: 120 },
      at: 1,
    })
    const second = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-2', 'system:read', 'page two'),
      toolArgs: { path: '/tmp/build.log', startLine: 120, endLine: 240 },
      createdAt: 2,
      turn: 0,
    })

    assert.equal(second.record.dedupeKey, null)
    assert.deepEqual(second.supersededIds, [])
    // 否决只针对去重：可重取由 isRefetchable 单独表态，不受牵连。
    assert.equal(second.record.refetchable, false)
  })

  test('注入具体目标仍然生效：不同 selector 的同页快照互不取代', () => {
    const classifier: ContextRecordClassifier = {
      isRefetchable: (input) => (input.toolName === 'browser:query_elements' ? true : undefined),
      resolveDedupeTarget: (input) => {
        if (input.toolName !== 'browser:query_elements') return undefined
        const args = input.toolArgs as { selector?: string }
        return `browser-active-page::${args.selector ?? ''}`
      },
    }
    const ledger = new ContextResidencyLedger({ classifier })
    appendToolResult(ledger, {
      toolCallId: 'call-1',
      toolName: 'browser:query_elements',
      value: '¥42',
      toolArgs: { selector: '.product-price' },
      at: 1,
    })
    const otherFacet = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-2', 'browser:query_elements', 'Widget'),
      toolArgs: { selector: '.product-title' },
      createdAt: 2,
      turn: 0,
    })
    const sameFacet = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-3', 'browser:query_elements', '¥39'),
      toolArgs: { selector: '.product-price' },
      createdAt: 3,
      turn: 0,
    })

    assert.deepEqual(otherFacet.supersededIds, [], '不同 selector 问的是页面的另一面，不是过时快照')
    assert.equal(sameFacet.supersededIds.length, 1, '同一 selector 的旧快照仍然过时')
  })

  test('pinned 表态给控制面结果一个 EXCERPT 地板，折不到墓碑', () => {
    const classifier: ContextRecordClassifier = {
      isPinned: (input) => (input.toolName === 'context:distill' ? true : undefined),
    }
    const ledger = new ContextResidencyLedger({ classifier })
    const recordId = appendToolResult(ledger, {
      toolCallId: 'call-1',
      toolName: 'context:distill',
      value: '{"distilled":true}',
      toolArgs: { facts: ['改了 /tmp/a.ts:42 的解析分支'] },
      at: 1,
    })

    const outcome = ledger.migrate(recordId, 'EVICTED', 'evict', 2)
    assert.equal(outcome.residency, 'EXCERPT')
    assert.equal(outcome.rejection, 'pinned-floor')
  })
})

void describe('migration events · 账本代数 (审计 desktop-wiring 优化 6)', () => {
  test('每条迁移/fault 事件都带 ledgerGeneration，重建后换代', () => {
    const sink = new InMemoryContextMigrationEventSink()
    const registry = new ContextGovernanceSessionRegistry({ sinkFactory: () => sink })
    const first: ModelMessage[] = [
      { role: 'user', content: '第一段对话' },
      toolCallMessage('call-1', 'system:read', { path: '/tmp/a.log' }),
      toolResultMessage('call-1', 'system:read', 'a'),
    ]
    const session = registry.resolve('s1')!
    session.syncHistory({ messages: first, at: 1 })
    assert.ok(sink.listMigrations().length > 0)
    assert.ok(sink.listMigrations().every((event) => event.ledgerGeneration === 0))

    // 前缀分叉（用户编辑/回卷历史）→ 整本重建 → 记录 id 从 ctx-r000001 重新发一遍。
    const generationBefore = sink.listMigrations().length
    session.syncHistory({ messages: [{ role: 'user', content: '换了一段对话' }], at: 2 })
    const rebuilt = sink.listMigrations().slice(generationBefore)

    assert.ok(rebuilt.length > 0)
    assert.ok(
      rebuilt.every((event) => event.ledgerGeneration === 1),
      '重建后的事件必须换代，否则离线重放会把两代同名 id 混成一条流'
    )
    assert.equal(rebuilt[0]!.recordId, sink.listMigrations()[0]!.recordId)
  })
})

void describe('turn-context ledger · 实例代次 (审计 U37)', () => {
  test('容量淘汰后重建的账本换代，旧 cursor 不会吞掉新 delta', () => {
    const ledgers = new TurnContextSessionLedgers('workspace.filesystem-touches', {
      maxSessions: 2,
      notifyRenderer: false,
    })
    for (let index = 0; index < 3; index += 1) {
      ledgers.append('session-a', { label: 'touch', summaryText: `第 ${index} 次触碰` })
    }
    const before = ledgers.peek('session-a', { afterSeq: 0, generation: null })
    assert.equal(before.tailSeq, 3)

    // 另外两个会话把 session-a 挤出去（maxSessions=2）。
    ledgers.append('session-b', { label: 'touch', summaryText: 'b' })
    ledgers.append('session-c', { label: 'touch', summaryText: 'c' })

    // 回到 session-a：账本重建、seq 从 1 起，但代次必须已经换过。
    ledgers.append('session-a', { label: 'touch', summaryText: '重建后的第一条' })
    const after = ledgers.peek('session-a', { afterSeq: before.tailSeq, generation: null })

    assert.notEqual(after.generation, before.generation)
    assert.equal(after.tailSeq, 1)
    // 消费方按协议对比代次：不同即整段替换 cursor，于是这条重建后的 delta 拿得到。
    const replayed = ledgers.peek('session-a', { afterSeq: 0, generation: after.generation })
    assert.equal(replayed.deltas.length, 1)
  })
})
