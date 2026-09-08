import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { extractContextAnchors } from '../src/agent/context/residency/anchors'
import { stableStringify } from '../src/agent/context/residency/determinism'
import {
  DefaultContextGovernanceConfig,
  resolveContextGovernanceConfig,
  resolveContextGovernancePreset,
} from '../src/agent/context/residency/governanceConfig'
import { resolveGovernanceWindowTokens } from '../src/agent/context/residency/governanceWindow'
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
    const text =
      'ran bun run check on packages/agent/src/index.ts and it exited with exit code 3; ContextResidencyLedger is fine'
    const anchors = extractContextAnchors(text)
    const texts = anchors.map((anchor) => anchor.text)
    assert.ok(texts.includes('packages/agent/src/index.ts'))
    // 命令锚逐字沿用 v1 的停止词裁剪：散文停止词（and/or/then…）才断，介词不断。
    assert.ok(texts.includes('bun run check on packages/agent/src/index.ts'))
    assert.ok(texts.includes('ContextResidencyLedger'))
    assert.ok(texts.some((anchor) => anchor.toLowerCase().includes('exit code 3')))
    assert.deepEqual(anchors, extractContextAnchors(text))
    // 类别在准入期就定下：骨架据此分栏，不再靠一条更弱的正则二次分类（审计 V13）。
    assert.deepEqual(
      anchors.find((anchor) => anchor.text === 'packages/agent/src/index.ts')?.kind,
      'path'
    )
    assert.deepEqual(anchors.find((anchor) => anchor.text.startsWith('bun run'))?.kind, 'command')
    assert.deepEqual(anchors.find((anchor) => anchor.text === 'ContextResidencyLedger')?.kind, 'identifier')
  })

  void test('recognizes Markdown-wrapped commands without consuming surrounding prose', () => {
    const anchors = extractContextAnchors(
      'Run `bun run check` then explain the result; use (npm test) afterwards and `pytest tests/unit.py -q` passed.'
    ).filter((anchor) => anchor.kind === 'command')

    assert.deepEqual(anchors.map((anchor) => anchor.text), [
      'bun run check',
      'npm test',
      'pytest tests/unit.py -q',
    ])
  })

  void test('preserves ordinary positional command arguments until a prose stop word', () => {
    const commands = extractContextAnchors(
      'bun test foo and report; bun run check on packages/agent then explain.'
    ).filter((anchor) => anchor.kind === 'command')

    assert.deepEqual(commands.map((anchor) => anchor.text), [
      'bun test foo',
      'bun run check on packages/agent',
    ])
  })

  for (const [source, expected] of [
    ['"bun run check" afterwards', 'bun run check'],
    ["'npm test' afterwards", 'npm test'],
    ['**pnpm run build** afterwards', 'pnpm run build'],
    ['[yarn test](https://example.com) afterwards', 'yarn test'],
    ['<pytest tests/unit.py> afterwards', 'pytest tests/unit.py'],
  ] as const) {
    void test(`stops a wrapped command at its closing boundary: ${expected}`, () => {
      const commands = extractContextAnchors(source).filter((anchor) => anchor.kind === 'command')
      assert.deepEqual(commands.map((anchor) => anchor.text), [expected])
    })
  }

  for (const [source, expected] of [
    ['exit code\n1', 'exit code 1'],
    ['line\r\n42', 'line 42'],
    ['port:\n5173', 'port: 5173'],
  ] as const) {
    void test(`preserves a semantic number across line endings: ${expected}`, () => {
      assert.deepEqual(extractContextAnchors(source, 1), [{ text: expected, kind: 'number' }])
    })
  }
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
    assert.deepEqual((envelope.retrieval as Record<string, unknown>).tool, 'context:recall')
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

  void test('unknown tools are not treated as safely refetchable just because args contain a path', () => {
    const ledger = new ContextResidencyLedger()
    const appended = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-write', 'unknown_mutation', 'done'),
      createdAt: 1,
      turn: 0,
      toolArgs: { path: '/repo/output.bin' },
    })

    assert.equal(appended.record.dedupeKey, 'unknown_mutation::/repo/output.bin')
    assert.equal(appended.record.refetchable, false)
    assert.deepEqual(appended.supersededIds, [])
  })

  void test('same tool + same target marks the older snapshot pending-EVICT without touching it', () => {
    const ledger = new ContextResidencyLedger({
      classifier: {
        isRefetchable: (input) => (input.toolName === 'inspect_page' ? true : undefined),
      },
    })
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

  void test('faults are counted, page the record back in and report recovery', () => {
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
    assert.equal(ledger.residencyOf(record.id), 'INLINE')
    assert.ok((ledger.warmUntilTurnOf(record.id) ?? -1) >= 6)
    assert.equal(ledger.faultCountOf(record.id), 1)
    assert.equal(sink.listFaults()[0]?.ageMs, 200)
    assert.equal(ledger.stats().totalFaults, 1)
    assert.ok(
      sink.listMigrations().some(
        (event) => event.recordId === record.id && event.cause === 'fault-page-in'
      )
    )
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

  void test('tail protection does not re-inflate a declared downgrade (v3 · R1)', () => {
    // 语义改判（v3 · R1）：尾保护 = **治理器不得再降这条记录**（候选集与蒸馏段按 id 排除窗口内
    // 记录），而不是"把已降级的记录在渲染面还原成全文"。旧语义下窗口是「最近 N 轮 ∩ 最近 M 条」，
    // 每追加一条就滑一格，滑出去那条的渲染当场从全文变信封 —— 位置固定在前缀中段，既不产 epoch
    // 报告也不落迁移事件，KV 缓存却每轮失效一次（P4「每 epoch 恰好一次缓存重建」被自己的保护破掉）。
    //
    // 这里用手工 migrate 制造"窗口内的已降级记录"——治理器本身产不出这一形态（窗口只出不进）——
    // 断言投影诚实反映账本：账本说降了就是降了，渲染面不上翻。
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
    assert.equal(projected.stats.tailProtectedRecordIds.length, 1)
    assert.equal(projected.stats.tombstoneCount, 1)
    assert.notEqual(projected.messages[0]?.content, 'recent narrative')
    assert.ok(String(projected.messages[0]?.content).includes(record.id))
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
    assert.ok(!content.includes('context:recall'))
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
    // nextTurn 不预支：跨批的"见过边界没有"单独带走，否则增量与整批对同一份历史给出两套轮序。
    assert.equal(plan.nextTurn, 1)
    assert.equal(plan.turnBoundarySeen, true)

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
      distillation: { targetChars: 999_999, minSegmentChars: 999_999, maxInputChars: 20_000 },
    })

    assert.equal(resolved.cap, 1_000)
    assert.equal(resolved.tailProtectTurns, 100)
    assert.equal(resolved.epochTriggerPercent, 100)
    assert.equal(resolved.epochTargetPercent, 99)
    assert.equal(resolved.minEpochSavingPercent, 1)
    assert.equal(resolved.admission.inlineMaxChars, 200)
    // 未知档位回落**默认档**（B2 起 'aux'）：把手滑的配置解释成"关掉治理"比解释成"用默认策略"危险。
    assert.equal(resolved.instruments.distill, 'aux')
    // 蒸馏护栏的两条语义不变量：目标不得 ≥ 输入的一半（否则产物永远过不了"更短"那道验证），
    // 段落下限不得超过输入上限（否则永远选不出段）。
    assert.equal(resolved.distillation.maxInputChars, 20_000)
    assert.equal(resolved.distillation.targetChars, 10_000)
    assert.equal(resolved.distillation.minSegmentChars, 20_000)
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

  /**
   * 量纲统一批改判（原断言：G === min(模型窗口, cap)）。
   *
   * G 由真实可用输入容量减固定开销得到，与大窗口及输出预留保持一致。
   */
  void test('governance window uses the complete available input capacity', () => {
    const config = resolveContextGovernanceConfig()
    assert.equal(resolveGovernanceWindowTokens(config, { modelWindowTokens: 1_000_000 }), 1_000_000)
    assert.equal(resolveGovernanceWindowTokens(config, { modelWindowTokens: 128_000 }), 128_000)
    // 窗口缺席 = `estimateContextUsage` 的默认 128K，与门用同一条兜底，不再退化成 cap。
    assert.equal(resolveGovernanceWindowTokens(config, {}), 128_000)
    // 输出预留 + 安全余量一进来，两把尺子一起缩：G 必须跟着门的 usable 走。
    assert.equal(
      resolveGovernanceWindowTokens(config, {
        modelWindowTokens: 128_000,
        reservedOutputTokens: 16_000,
        safetyMarginPercent: 4,
      }),
      // usable = floor(128_000 × 0.96) − 16_000 = 106_880。
      106_880
    )
  })
})
