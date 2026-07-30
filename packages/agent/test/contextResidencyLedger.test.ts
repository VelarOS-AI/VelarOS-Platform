import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { extractContextAnchors } from '../src/agent/context/residency/anchors'
import { stableStringify } from '../src/agent/context/residency/determinism'
import {
  DefaultContextGovernanceConfig,
  resolveContextGovernanceConfig,
  resolveContextGovernancePreset,
  resolveGovernanceWindowTokens,
} from '../src/agent/context/residency/governanceConfig'
import { ingestHistoryIntoLedger, planHistoryIngest } from '../src/agent/context/residency/ingest'
import { InMemoryContextMigrationEventSink } from '../src/agent/context/residency/migrationLog'
import { projectContextLedger } from '../src/agent/context/residency/projection'
import { ContextResidencyLedger } from '../src/agent/context/residency/ResidencyLedger'

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text }
}

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

function readToolResultValue(message: ModelMessage): string {
  const part = (message.content as Array<Record<string, unknown>>)[0]
  const output = part?.output as Record<string, unknown>
  return String(output.value)
}

void describe('context residency ledger · determinism (P7)', () => {
  void test('stable stringify sorts keys at every depth and drops undefined', () => {
    const left = stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] }, z: undefined })
    const right = stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 })
    assert.equal(left, right)
    assert.equal(left, '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}')
  })

  void test('projection is byte-identical across repeated calls', () => {
    const ledger = new ContextResidencyLedger()
    ingestHistoryIntoLedger(ledger, [
      userMessage('read src/app.ts then run bun run check'),
      toolCallMessage('call-1', 'read_file', { path: 'src/app.ts' }),
      toolResultMessage('call-1', 'read_file', 'export const app = 1'),
    ])

    const budget = { tailProtectTurns: 0, budgetTokens: 200_000 }
    const first = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget,
    })
    const second = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget,
    })

    assert.equal(stableStringify(first.messages), stableStringify(second.messages))
    assert.equal(first.stats.ledgerFingerprint, second.stats.ledgerFingerprint)
  })
})

void describe('context residency ledger · anchors', () => {
  void test('extracts paths, commands, identifiers and semantic numbers in a stable order', () => {
    const anchors = extractContextAnchors(
      'ran bun run check on packages/agent/src/index.ts and it exited with exit code 3; ContextResidencyLedger is fine'
    )
    assert.ok(anchors.includes('packages/agent/src/index.ts'))
    // 命令锚逐字沿用 v1 的停止词裁剪：散文停止词（and/or/then…）才断，介词不断。
    assert.ok(anchors.some((anchor) => anchor.startsWith('bun run check')))
    assert.ok(anchors.includes('ContextResidencyLedger'))
    assert.ok(anchors.some((anchor) => anchor.toLowerCase().includes('exit code 3')))
    assert.deepEqual(
      anchors,
      extractContextAnchors(
        'ran bun run check on packages/agent/src/index.ts and it exited with exit code 3; ContextResidencyLedger is fine'
      )
    )
  })
})

void describe('context residency ledger · admission (§4A)', () => {
  void test('oversize tool results are admitted as EXCERPT with a recall envelope', () => {
    const sink = new InMemoryContextMigrationEventSink()
    const ledger = new ContextResidencyLedger({
      config: resolveContextGovernanceConfig({ admission: { inlineMaxChars: 400 } }),
      sink,
    })
    const oversize = 'x'.repeat(5_000)
    const appended = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-1', 'read_file', oversize),
      createdAt: 1_000,
      turn: 0,
      toolArgs: { path: '/tmp/big.txt' },
    })

    assert.equal(appended.record.admittedResidency, 'EXCERPT')
    assert.ok(appended.record.bytes.excerpt > 0)
    assert.ok(appended.record.bytes.excerpt < appended.record.bytes.full)
    assert.equal(sink.listMigrations()[0]?.cause, 'admission-oversize')

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    const envelope = JSON.parse(readToolResultValue(projected.messages[0]!)) as Record<string, unknown>
    assert.equal(envelope.__contextRef, 'tool-output')
    assert.deepEqual((envelope.retrieval as Record<string, unknown>).tool, 'recall_context')
  })

  void test('small tool results stay INLINE', () => {
    const ledger = new ContextResidencyLedger()
    const appended = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-1', 'read_file', 'small'),
      createdAt: 1,
      turn: 0,
    })
    assert.equal(appended.record.admittedResidency, 'INLINE')
    assert.equal(appended.record.bytes.excerpt, 0)
  })

  void test('same tool + same target marks the older snapshot pending-EVICT without touching it', () => {
    const ledger = new ContextResidencyLedger()
    const first = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-1', 'inspect_page', 'page v1'),
      createdAt: 1,
      turn: 0,
      toolArgs: { url: 'https://example.com/docs' },
    })
    const second = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-2', 'inspect_page', 'page v2'),
      createdAt: 2,
      turn: 0,
      toolArgs: { url: 'https://example.com/docs#section' },
    })

    assert.deepEqual(second.supersededIds, [first.record.id])
    assert.deepEqual(ledger.pendingEvictions(), [first.record.id])
    // 只标记，不迁移（P1：真正逐出归 B1 的 epoch）。
    assert.equal(ledger.residencyOf(first.record.id), 'INLINE')
  })

  void test('a different target on the same tool is not deduped', () => {
    const ledger = new ContextResidencyLedger()
    ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-1', 'inspect_page', 'a'),
      createdAt: 1,
      turn: 0,
      toolArgs: { url: 'https://example.com/a' },
    })
    const second = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-2', 'inspect_page', 'b'),
      createdAt: 2,
      turn: 0,
      toolArgs: { url: 'https://example.com/b' },
    })
    assert.deepEqual(second.supersededIds, [])
  })
})

void describe('context residency ledger · migrations (P1/P2/P6)', () => {
  void test('downgrades apply, upgrades are refused, pinned records stop at EXCERPT', () => {
    const sink = new InMemoryContextMigrationEventSink()
    const ledger = new ContextResidencyLedger({ sink })
    const record = ledger.append({
      kind: 'assistant',
      message: { role: 'assistant', content: 'a'.repeat(2_000) },
      createdAt: 10,
      turn: 0,
    }).record
    const guardrail = ledger.append({
      kind: 'governance',
      message: { role: 'system', content: 'never delete without confirmation' },
      createdAt: 11,
      turn: 0,
    }).record

    assert.equal(guardrail.pinned, true)

    const evicted = ledger.migrate(record.id, 'EVICTED', 'evict', 20)
    assert.equal(evicted.applied, true)
    assert.ok((evicted.event?.tokensDelta ?? 0) < 0)

    const upgrade = ledger.migrate(record.id, 'INLINE', 'evict', 21)
    assert.equal(upgrade.applied, false)
    assert.equal(upgrade.rejection, 'upgrade-not-allowed')

    const pinnedFloor = ledger.migrate(guardrail.id, 'EVICTED', 'evict', 22)
    assert.equal(pinnedFloor.residency, 'EXCERPT')
    assert.equal(pinnedFloor.rejection, 'pinned-floor')
    assert.equal(ledger.residencyOf(guardrail.id), 'EXCERPT')

    // 追加事件 2 条 + 降级事件 2 条（被拒的迁移不落事件）。
    assert.equal(sink.listMigrations().length, 4)
  })

  void test('faults are counted and reported', () => {
    const sink = new InMemoryContextMigrationEventSink()
    const ledger = new ContextResidencyLedger({ sink })
    const record = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-1', 'read_file', 'body'),
      createdAt: 100,
      turn: 0,
    }).record

    ledger.migrate(record.id, 'EVICTED', 'evict', 200)
    assert.equal(ledger.recordFault(record.id, 300), 1)
    assert.equal(ledger.recordFault(record.id, 400), 2)
    assert.equal(ledger.faultCountOf(record.id), 2)
    assert.equal(sink.listFaults()[1]?.ageMs, 300)
    assert.equal(ledger.stats().totalFaults, 2)
  })
})

void describe('context residency ledger · projection layout', () => {
  void test('lays out stable prefix, ledger body and active tail in that order', () => {
    const ledger = new ContextResidencyLedger()
    ingestHistoryIntoLedger(ledger, [userMessage('turn one'), userMessage('turn two')])

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 1, budgetTokens: 1_000 },
      stablePrefix: [{ role: 'system', content: 'stable prefix' }],
      tailBlocks: [{ role: 'user', content: 'turn-context delta' }],
    })

    assert.deepEqual(
      projected.messages.map((message) => message.content),
      ['stable prefix', 'turn one', 'turn two', 'turn-context delta']
    )
    assert.equal(projected.stats.tailProtectedRecordIds.length, 1)
    assert.equal(projected.stats.recordCount, 2)
    assert.ok(projected.stats.occupancyPercent !== null)
  })

  void test('tail protection overrides a declared downgrade', () => {
    const ledger = new ContextResidencyLedger()
    const record = ledger.append({
      kind: 'assistant',
      message: { role: 'assistant', content: 'recent narrative' },
      createdAt: 1,
      turn: 0,
    }).record
    ledger.migrate(record.id, 'EVICTED', 'evict', 2)

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 2 },
    })
    assert.equal(projected.messages[0]?.content, 'recent narrative')
  })

  void test('evicted tool results keep their message shell so tool pairing survives', () => {
    const ledger = new ContextResidencyLedger()
    ingestHistoryIntoLedger(ledger, [
      userMessage('go'),
      toolCallMessage('call-1', 'read_file', { path: 'a.ts' }),
      toolResultMessage('call-1', 'read_file', 'file body'),
    ])
    const resultRecord = ledger.list().find((record) => record.kind === 'tool-result')!
    const callRecord = ledger.list().find((record) => record.kind === 'tool-call')!
    ledger.migrate(resultRecord.id, 'EVICTED', 'evict', 5)
    ledger.migrate(callRecord.id, 'SUMMARIZED', 'skeleton', 5)

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })

    const roles = projected.messages.map((message) => message.role)
    assert.deepEqual(roles, ['user', 'assistant', 'tool'])
    const toolMessage = projected.messages[2]!
    const part = (toolMessage.content as Array<Record<string, unknown>>)[0]!
    assert.equal(part.toolCallId, 'call-1')
    assert.ok(readToolResultValue(toolMessage).includes('history-budget-truncated'))
    assert.equal(projected.stats.tombstoneCount, 2)
  })

  void test('summarized narrative records disappear from the projection', () => {
    const ledger = new ContextResidencyLedger()
    const older = ledger.append({
      kind: 'assistant',
      message: { role: 'assistant', content: 'long narrative' },
      createdAt: 1,
      turn: 0,
    }).record
    ledger.append({
      kind: 'summary',
      message: { role: 'assistant', content: 'skeleton summary' },
      createdAt: 2,
      turn: 0,
      memberIds: [older.id],
    })
    ledger.migrate(older.id, 'SUMMARIZED', 'skeleton', 3)

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    assert.deepEqual(
      projected.messages.map((message) => message.content),
      ['skeleton summary']
    )
    assert.equal(projected.stats.hiddenCount, 1)
  })

  void test('expired records get an honest non-recallable tombstone', () => {
    const ledger = new ContextResidencyLedger()
    const record = ledger.append({
      kind: 'assistant',
      message: { role: 'assistant', content: 'gone' },
      createdAt: 1,
      turn: 0,
    }).record
    ledger.migrate(record.id, 'EXPIRED', 'expire', 2)

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    const content = String(projected.messages[0]?.content)
    assert.ok(content.includes('expired'))
    assert.ok(!content.includes('recall_context'))
  })
})

void describe('context residency ledger · ingest', () => {
  void test('is lossless and numbers turns on real user messages', () => {
    const history: ModelMessage[] = [
      userMessage('first task'),
      toolCallMessage('call-1', 'read_file', { path: 'src/a.ts' }),
      toolResultMessage('call-1', 'read_file', 'body'),
      { role: 'assistant', content: 'done' },
      userMessage('second task'),
    ]

    const plan = planHistoryIngest(history)
    assert.deepEqual(
      plan.inputs.map((input) => input.kind),
      ['user', 'tool-call', 'tool-result', 'assistant', 'user']
    )
    assert.deepEqual(
      plan.inputs.map((input) => input.turn),
      [0, 0, 0, 0, 1]
    )
    assert.deepEqual(plan.inputs[2]?.toolArgs, { path: 'src/a.ts' })
    assert.equal(plan.nextTurn, 2)

    const ledger = new ContextResidencyLedger()
    ingestHistoryIntoLedger(ledger, history)
    assert.equal(ledger.list().length, history.length)
    assert.deepEqual(
      projectContextLedger({
        records: ledger.list(),
        residency: ledger.residencyVector(),
        budget: { tailProtectTurns: 0 },
      }).messages,
      history
    )
  })

  void test('produces an identical ledger when the same history is ingested twice', () => {
    const history: ModelMessage[] = [
      userMessage('task'),
      toolResultMessage('call-1', 'read_file', 'body'),
    ]
    const left = new ContextResidencyLedger()
    const right = new ContextResidencyLedger()
    ingestHistoryIntoLedger(left, history)
    ingestHistoryIntoLedger(right, history)
    assert.equal(stableStringify(left.list()), stableStringify(right.list()))
  })
})

void describe('context residency ledger · governance config (§7)', () => {
  void test('clamps out-of-range input instead of rejecting it', () => {
    const resolved = resolveContextGovernanceConfig({
      cap: -1,
      tailProtectTurns: 9_999,
      epochTriggerPercent: 500,
      epochTargetPercent: 500,
      minEpochSavingPercent: 0,
      admission: { inlineMaxChars: 1 },
      instruments: { distill: 'nope' },
    })

    assert.equal(resolved.cap, 1_000)
    assert.equal(resolved.tailProtectTurns, 100)
    assert.equal(resolved.epochTriggerPercent, 100)
    assert.equal(resolved.epochTargetPercent, 99)
    assert.equal(resolved.minEpochSavingPercent, 1)
    assert.equal(resolved.admission.inlineMaxChars, 200)
    assert.equal(resolved.instruments.distill, 'aux')
  })

  void test('defaults match the design sheet and excerpt budget tracks the admission threshold', () => {
    const resolved = resolveContextGovernanceConfig()
    assert.deepEqual(resolved, DefaultContextGovernanceConfig)
    assert.equal(
      resolveContextGovernanceConfig({ admission: { inlineMaxChars: 8_000 } }).admission
        .excerptMaxChars,
      8_000
    )
  })

  void test('experiment presets only move the instrument dials', () => {
    assert.deepEqual(resolveContextGovernancePreset('A0-truncation').instruments, {
      skeleton: false,
      distill: 'off',
    })
    assert.deepEqual(resolveContextGovernancePreset('A3-adaptive').instruments, {
      skeleton: true,
      distill: 'adaptive',
    })
    assert.equal(
      resolveContextGovernancePreset('A0-truncation').epochTriggerPercent,
      DefaultContextGovernanceConfig.epochTriggerPercent
    )
  })

  void test('governance window is min(model window, cap)', () => {
    const config = resolveContextGovernanceConfig()
    assert.equal(resolveGovernanceWindowTokens(config, 1_000_000), 200_000)
    assert.equal(resolveGovernanceWindowTokens(config, 128_000), 128_000)
    assert.equal(resolveGovernanceWindowTokens(config, null), 200_000)
  })
})
