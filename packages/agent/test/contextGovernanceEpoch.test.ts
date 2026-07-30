/**
 * 上下文治理 v2 · B1 断言电池。
 *
 * 三条主线：
 *  ① GovernanceEpoch 状态机（触发 / 反空转 / I0 / I1 / 尾保护硬不变量 / I2 显式降级）；
 *  ② 会话治理器（增量摄入与分叉重建 / distill 请求 / fault / 转交信号）；
 *  ③ **编译器切换的行为对齐**——治理未触发时编译器出口与切换前逐字等价。
 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { buildSystemPromptDelivery } from '../src/agent'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import {
  ContextGovernanceSession,
  ContextGovernanceSessionRegistry,
} from '../src/agent/context/residency/ContextGovernanceSession'
import { isContextDashboardText } from '../src/agent/context/residency/dashboard'
import { stableStringify } from '../src/agent/context/residency/determinism'
import {
  DefaultContextGovernanceConfig,
  resolveContextGovernanceConfig,
} from '../src/agent/context/residency/governanceConfig'
import { runGovernanceEpoch } from '../src/agent/context/residency/GovernanceEpoch'
import { ingestHistoryIntoLedger } from '../src/agent/context/residency/ingest'
import { InMemoryContextMigrationEventSink } from '../src/agent/context/residency/migrationLog'
import { projectContextLedger } from '../src/agent/context/residency/projection'
import { ContextResidencyLedger } from '../src/agent/context/residency/ResidencyLedger'
import { buildContextSkeleton } from '../src/agent/context/residency/skeleton'
import { buildKernelPrefixShape } from '../src/kernel/prefix-shape'

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text }
}

function assistantMessage(text: string): ModelMessage {
  return { role: 'assistant', content: text }
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

/**
 * 造一段"够长、够多轮"的历史：每轮一条 user + 一对工具调用/结果。
 *
 * 路径刻意用绝对形式：`extractResourceLocator` 只认结构信号（URL / 绝对或显式相对路径），
 * 相对裸路径不构成去重目标，那样造出来的工具结果不是"可重取"的，压根进不了 I0 前两档。
 */
function buildPressureHistory(turns: number, bodyChars: number): ModelMessage[] {
  const history: ModelMessage[] = []
  for (let index = 0; index < turns; index += 1) {
    history.push(userMessage(`turn ${index} instruction`))
    history.push(toolCallMessage(`call-${index}`, 'read_file', { path: `/repo/src/file-${index}.ts` }))
    history.push(
      toolResultMessage(`call-${index}`, 'read_file', 'body '.repeat(Math.ceil(bodyChars / 5)))
    )
  }
  return history
}

function projectedTokensOf(
  ledger: ContextResidencyLedger,
  tailProtectTurns: number
): number {
  return projectContextLedger({
    records: ledger.list(),
    residency: ledger.residencyVector(),
    budget: { tailProtectTurns },
  }).stats.projectedTokens
}

void describe('governance epoch · 触发与反空转 (§4B)', () => {
  void test('占用低于触发水位且模型未请求时整个跳过', () => {
    const ledger = new ContextResidencyLedger()
    ingestHistoryIntoLedger(ledger, [userMessage('small task')])

    const report = runGovernanceEpoch({
      ledger,
      config: DefaultContextGovernanceConfig,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1_000,
    })

    assert.equal(report.applied, false)
    assert.equal(report.skipReason, 'below-trigger')
    assert.equal(report.trigger, null)
    assert.equal(report.migrationCount, 0)
  })

  void test('模型请求可以在水位之下开 epoch', () => {
    const config = resolveContextGovernanceConfig({ tailProtectTurns: 0, minEpochSavingPercent: 1 })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, buildPressureHistory(6, 4_000))

    const report = runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })

    assert.equal(report.trigger, 'model-request')
    assert.equal(report.applied, true)
    assert.ok(report.savedTokens > 0)
  })

  void test('预计节省低于 minEpochSavingPercent 时跳过并记账，不动任何记录', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 99,
    })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, buildPressureHistory(4, 2_000))
    const before = stableStringify([...ledger.residencyVector()])

    const report = runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })

    assert.equal(report.skipReason, 'insufficient-saving')
    assert.equal(report.applied, false)
    assert.equal(stableStringify([...ledger.residencyVector()]), before)
  })
})

void describe('governance epoch · I0 逐出与硬不变量', () => {
  void test('尾保护窗口内的记录永不被选中（裁决 5：不设旁路）', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 2,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, buildPressureHistory(6, 4_000))
    const latestTurn = ledger.list().reduce((max, record) => Math.max(max, record.turn), 0)

    runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })

    for (const record of ledger.list()) {
      if (record.turn < latestTurn - 1) continue
      assert.equal(ledger.residencyOf(record.id), record.admittedResidency)
    }
  })

  void test('治理类记录（P6 护栏）不进候选，连 EXCERPT 都不降', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const ledger = new ContextResidencyLedger({ config })
    const guardrail = ledger.append({
      kind: 'governance',
      message: { role: 'system', content: '删除前必须确认'.repeat(200) },
      createdAt: 1,
      turn: 0,
    }).record
    ingestHistoryIntoLedger(ledger, buildPressureHistory(6, 4_000), { startTurn: 1 })

    runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })

    assert.equal(ledger.residencyOf(guardrail.id), 'INLINE')
  })

  void test('被新快照取代的旧记录最先逐出，迁移因果记 superseded', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const sink = new InMemoryContextMigrationEventSink()
    const ledger = new ContextResidencyLedger({ config, sink })
    const stale = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-1', 'inspect_page', 'page v1 '.repeat(2_000)),
      createdAt: 1,
      turn: 0,
      toolArgs: { url: 'https://example.com/docs' },
    }).record
    ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-2', 'inspect_page', 'page v2 '.repeat(2_000)),
      createdAt: 2,
      turn: 1,
      toolArgs: { url: 'https://example.com/docs' },
    })

    runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })

    assert.equal(ledger.residencyOf(stale.id), 'EVICTED')
    assert.ok(
      sink.listMigrations().some((event) => event.recordId === stale.id && event.cause === 'superseded')
    )
  })

  void test('工具记录降级只换正文留结构壳，投影仍能过配对校验', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, buildPressureHistory(6, 4_000))

    runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })
    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })

    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const message of projected.messages) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === 'tool-call') callIds.add(String(part.toolCallId))
        if (part.type === 'tool-result') resultIds.add(String(part.toolCallId))
      }
    }
    assert.deepEqual([...callIds].sort(), [...resultIds].sort())
  })
})

void describe('governance epoch · I1 规则骨架与 I2 显式降级', () => {
  void test('折叠的叙事段产出六字段骨架记录，anchors 逐字并入、成员迁 SUMMARIZED', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
      instruments: { skeleton: true, distill: 'off' },
    })
    const ledger = new ContextResidencyLedger({ config })
    // 叙事段刻意"长而稀"：锚点密度低才进 I0 候选（密集锚点的段落本来就不该被折）。
    const prose = '这里是一段没有硬事实的过程叙述。'.repeat(120)
    ingestHistoryIntoLedger(ledger, [
      userMessage(`目标是把 packages/agent/src/index.ts 接进新链路。${prose}`),
      assistantMessage(
        `决定改为走驻留账本；跑 bun run check 通过；未决：还要补 kernel 的哈希。${prose}`
      ),
      ...buildPressureHistory(5, 4_000),
    ])

    const report = runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 3,
      at: 1_000,
      modelRequested: true,
    })

    const skeleton = ledger.list().find((record) => record.kind === 'summary')
    assert.ok(skeleton, '应当产出一条 summary 骨架记录')
    assert.ok(report.byInstrument.skeleton > 0)
    assert.equal(skeleton.memberIds.length, report.byInstrument.skeleton)
    for (const memberId of skeleton.memberIds) {
      assert.equal(ledger.residencyOf(memberId), 'SUMMARIZED')
    }

    const text = String(skeleton.message?.content)
    assert.ok(text.startsWith('[context-skeleton epoch=3'))
    assert.ok(text.includes('- 目标：'))
    assert.ok(text.includes('- 决策：'))
    assert.ok(text.includes('packages/agent/src/index.ts'))
    assert.ok(text.includes('bun run check'))
  })

  void test('骨架自身不会在下一次 epoch 里被当叙事再折一遍', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, [
      assistantMessage('决定采用账本；bun run check 通过'),
      ...buildPressureHistory(5, 4_000),
    ])
    runGovernanceEpoch({ ledger, config, budgetTokens: 200_000, epoch: 1, at: 1, modelRequested: true })
    const skeleton = ledger.list().find((record) => record.kind === 'summary')!

    runGovernanceEpoch({ ledger, config, budgetTokens: 200_000, epoch: 2, at: 2, modelRequested: true })
    assert.equal(ledger.residencyOf(skeleton.id), 'INLINE')
  })

  void test('distill 档位非 off 时显式记为"降级为骨架"，不静默', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
      instruments: { skeleton: true, distill: 'adaptive' },
    })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, buildPressureHistory(6, 4_000))

    const report = runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1,
      modelRequested: true,
    })
    assert.equal(report.distillDowngradedToSkeleton, true)
    assert.equal(report.byInstrument.distill, 0)
  })

  void test('骨架生成是确定的：同输入必同字节', () => {
    const ledger = new ContextResidencyLedger()
    ingestHistoryIntoLedger(ledger, [
      userMessage('目标：修 src/a.ts'),
      assistantMessage('决定改用码元序；bun run check 通过；未决：待补测试'),
    ])
    const members = ledger.list()
    assert.equal(
      buildContextSkeleton({ members, epoch: 1 })?.text,
      buildContextSkeleton({ members, epoch: 1 })?.text
    )
  })
})

void describe('governance session · 摄入 / 请求 / fault / 转交', () => {
  void test('前缀一致只增量追加，前缀分叉整本重建', () => {
    const session = new ContextGovernanceSession(DefaultContextGovernanceConfig, null, null)
    const base = [userMessage('a'), assistantMessage('b')]

    const first = session.syncHistory({ messages: base, at: 1 })
    assert.equal(first.rebuilt, false)
    assert.equal(first.appendedCount, 2)

    // 上游每轮重建消息对象：靠内容指纹认前缀，不靠对象身份。
    const grown = [userMessage('a'), assistantMessage('b'), userMessage('c')]
    const second = session.syncHistory({ messages: grown, at: 2 })
    assert.equal(second.rebuilt, false)
    assert.equal(second.appendedCount, 1)
    assert.equal(session.ledger.list().length, 3)

    const diverged = [userMessage('x'), assistantMessage('y')]
    const third = session.syncHistory({ messages: diverged, at: 3 })
    assert.equal(third.rebuilt, true)
    assert.equal(session.ledger.list().length, 2)
  })

  void test('distill_context 只触发一次 epoch，同一条调用不重复触发', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const session = new ContextGovernanceSession(config, null, null)
    const history = [
      ...buildPressureHistory(5, 4_000),
      toolCallMessage('call-distill', 'distill_context', { facts: ['x'] }),
      toolResultMessage('call-distill', 'distill_context', '{"distilled":true}'),
    ]
    session.syncHistory({ messages: history, at: 1_000 })

    const first = session.governTurn({ at: 1_000, modelWindowTokens: 200_000 })
    assert.equal(first?.trigger, 'model-request')

    const second = session.governTurn({ at: 2_000, modelWindowTokens: 200_000 })
    assert.equal(second?.trigger, null)
    assert.equal(second?.skipReason, 'below-trigger')
  })

  void test('fault 按 payloadRef / toolCallId / 记录 id 三种引用都能命中；INLINE 记录不算缺页', () => {
    const session = new ContextGovernanceSession(DefaultContextGovernanceConfig, null, null)
    const record = session.ledger.append({
      kind: 'tool-result',
      message: toolResultMessage('call-7', 'read_file', 'body'),
      createdAt: 1,
      turn: 0,
      payloadRef: 'ctx-payload:abc',
    }).record

    // 还在 INLINE 时召回不是缺页（那一页本来就在）。
    assert.equal(session.recordFault('ctx-payload:abc', 5), false)

    session.ledger.migrate(record.id, 'EVICTED', 'evict', 6)
    assert.equal(session.recordFault('ctx-payload:abc', 10), true)
    assert.equal(session.recordFault('tool:call-7', 20), true)
    assert.equal(session.recordFault(record.id, 30), true)
    assert.equal(session.recordFault('nope', 40), false)
    assert.equal(session.ledger.faultCountOf(record.id), 3)
  })

  void test('连续两次零收益 epoch 且占用仍高 → 布防转交', () => {
    // 尾保护窗口盖住全部轮次 = 治理器一条也选不动（硬不变量），这正是"压不下去"的极端形态：
    // 出路是 handoff，不是压尾（裁决 5）。
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 100,
      epochTriggerPercent: 5,
      epochTargetPercent: 4,
      minEpochSavingPercent: 10,
    })
    const session = new ContextGovernanceSession(config, null, null)
    session.syncHistory({ messages: buildPressureHistory(20, 6_000), at: 1_000 })

    const first = session.governTurn({ at: 1_000, modelWindowTokens: 20_000 })
    const second = session.governTurn({ at: 2_000, modelWindowTokens: 20_000 })
    assert.equal(first?.skipReason, 'no-candidates')
    assert.equal(second?.savingPercent, 0)

    const signal = session.handoffSignal()
    assert.equal(signal.armed, true)
    assert.equal(signal.reason, 'low-saving-streak')
    assert.equal(signal.recentSavingPercents.length, 2)
    assert.ok((signal.lastEpochAfterPercent ?? 0) > 35)
  })

  void test('registry 按 sessionId 隔离状态，invalidate 后清场', () => {
    const registry = new ContextGovernanceSessionRegistry()
    registry.resolve('s1')!.syncHistory({ messages: [userMessage('a')], at: 1 })
    registry.resolve('s2')!.syncHistory({ messages: [userMessage('b'), userMessage('c')], at: 1 })

    assert.equal(registry.peek('s1')!.ledger.list().length, 1)
    assert.equal(registry.peek('s2')!.ledger.list().length, 2)

    registry.invalidateSession('s1')
    assert.equal(registry.peek('s1'), null)
    assert.equal(registry.resolve(' ')?.ledger.list().length, undefined)
  })

  void test('configure 只影响新会话，不半程换水位', () => {
    const registry = new ContextGovernanceSessionRegistry()
    const before = registry.resolve('s1')!
    registry.configure({ tailProtectTurns: 9 })

    assert.equal(before.config.tailProtectTurns, DefaultContextGovernanceConfig.tailProtectTurns)
    assert.equal(registry.resolve('s2')!.config.tailProtectTurns, 9)
  })
})

void describe('准入层 · 48K 超长 user 正文安全阀（裁决 2）', () => {
  void test('超长 user 消息以 EXCERPT 准入，投影保留 user 角色并给出召回指引', () => {
    const config = resolveContextGovernanceConfig({ admission: { userInlineMaxChars: 2_000 } })
    const ledger = new ContextResidencyLedger({ config })
    const record = ledger.append({
      kind: 'user',
      message: userMessage('需求'.repeat(5_000)),
      createdAt: 1,
      turn: 0,
      payloadRef: 'ctx-payload:user-1',
    }).record

    assert.equal(record.admittedResidency, 'EXCERPT')

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    const message = projected.messages[0]!
    assert.equal(message.role, 'user')
    const content = String(message.content)
    assert.ok(content.includes('user text truncated before provider replay'))
    assert.ok(content.includes('ctx-payload:user-1'))
  })

  void test('常规长度的 user 消息不受影响', () => {
    const ledger = new ContextResidencyLedger()
    const record = ledger.append({
      kind: 'user',
      message: userMessage('普通需求'),
      createdAt: 1,
      turn: 0,
    }).record
    assert.equal(record.admittedResidency, 'INLINE')
  })
})

void describe('编译器切换 · 行为对齐', () => {
  const history: ModelMessage[] = [
    userMessage('read src/app.ts'),
    toolCallMessage('call-1', 'read_file', { path: 'src/app.ts' }),
    toolResultMessage('call-1', 'read_file', 'export const app = 1'),
    assistantMessage('done'),
    userMessage('now summarize'),
  ]

  void test('治理未触发时，编译出口的历史段与输入逐字等价', () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiled = new ProviderRequestCompiler(registry).compileWithReclaim({
      model: 'gpt-test',
      systemPrompt: 'system',
      sessionId: 'align-1',
      messages: [...history],
      contextWindow: 200_000,
    })

    assert.equal(compiled.governanceEpoch?.applied, false)
    assert.equal(stableStringify(compiled.messages), stableStringify(history))
    assert.equal(compiled.historyRewriteFingerprint, undefined)
  })

  void test('同一会话连续两轮编译：第二轮只增量摄入，输出仍逐字等价', () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)
    const input = {
      model: 'gpt-test',
      systemPrompt: 'system',
      sessionId: 'align-2',
      contextWindow: 200_000,
    }
    compiler.compileWithReclaim({ ...input, messages: [...history] })

    const next = [...history, userMessage('next turn')]
    const compiled = compiler.compileWithReclaim({ ...input, messages: [...next] })

    assert.equal(stableStringify(compiled.messages), stableStringify(next))
    assert.equal(registry.peek('align-2')!.ledger.list().length, next.length)
  })

  void test('dashboard 开启时只在尾部追加一块，历史段不动', () => {
    const registry = new ContextGovernanceSessionRegistry()
    const compiled = new ProviderRequestCompiler(registry).compileWithReclaim({
      model: 'gpt-test',
      systemPrompt: 'system',
      sessionId: 'align-3',
      messages: [...history],
      contextWindow: 200_000,
    })

    assert.equal(compiled.messages.length, history.length + 1)
    assert.equal(stableStringify(compiled.messages.slice(0, history.length)), stableStringify(history))
    const tail = compiled.messages.at(-1)!
    assert.equal(tail.role, 'user')
    assert.ok(isContextDashboardText(String(tail.content)))
    assert.ok(String(tail.content).includes('epoch=0'))
  })

  void test('稳定前缀不进账本：系统提示词换了也不会把账本冲掉', () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)
    const prefix = (text: string): ModelMessage => ({ role: 'system', content: text })

    compiler.compileWithReclaim({
      model: 'gpt-test',
      systemPrompt: 'system',
      sessionId: 'prefix-1',
      messages: [prefix('tools: a,b'), ...history],
      contextWindow: 200_000,
    })
    const firstIds = registry.peek('prefix-1')!.ledger.list().map((record) => record.id)

    // 工具清单变化 → 稳定前缀字节变化。账本必须原封不动（否则驻留态 / fault / epoch 全清零）。
    const compiled = compiler.compileWithReclaim({
      model: 'gpt-test',
      systemPrompt: 'system',
      sessionId: 'prefix-1',
      messages: [prefix('tools: a,b,c'), ...history],
      contextWindow: 200_000,
    })

    assert.deepEqual(
      registry.peek('prefix-1')!.ledger.list().map((record) => record.id),
      firstIds
    )
    assert.equal(String(compiled.messages[0]?.content), 'tools: a,b,c')
    assert.equal(compiled.messages.length, history.length + 1)
  })

  void test('宿主 tailBlocks 排在历史之后、dashboard 之前', () => {
    const registry = new ContextGovernanceSessionRegistry()
    const compiled = new ProviderRequestCompiler(registry).compileWithReclaim({
      model: 'gpt-test',
      systemPrompt: 'system',
      sessionId: 'align-4',
      messages: [...history],
      contextWindow: 200_000,
      tailBlocks: [userMessage('[dynamic layer]')],
    })

    assert.equal(String(compiled.messages.at(-2)?.content), '[dynamic layer]')
    assert.ok(isContextDashboardText(String(compiled.messages.at(-1)?.content)))
  })
})

void describe('P7 确定性 · 前缀形状与系统提示词投递', () => {
  void test('P7-3：stableHash 按排序键序列化，键序不同的同内容哈希相同', () => {
    const left = buildKernelPrefixShape({
      systemPrompt: 'sp',
      availableToolNames: ['b_tool', 'a_tool'],
      toolSchemaChars: { b_tool: 20, a_tool: 10 },
      toolSchemaHashes: { b_tool: 'hb', a_tool: 'ha' },
    })
    const right = buildKernelPrefixShape({
      systemPrompt: 'sp',
      availableToolNames: ['a_tool', 'b_tool'],
      toolSchemaChars: { a_tool: 10, b_tool: 20 },
      toolSchemaHashes: { a_tool: 'ha', b_tool: 'hb' },
    })

    assert.equal(left.prefixHash, right.prefixHash)
    assert.equal(left.toolsHash, right.toolsHash)
  })

  void test('P7-1：dynamic 层进 tailBlocks 而不是第二条 leading system 消息', () => {
    const stable = `${'s'.repeat(3_000)}`
    const delivery = buildSystemPromptDelivery(`${stable}|dynamic-part`, stable.length)

    assert.equal(delivery.leadingMessages.length, 1)
    assert.equal(delivery.leadingMessages[0]?.role, 'system')
    assert.equal(delivery.tailBlocks.length, 1)
    assert.equal(delivery.tailBlocks[0]?.role, 'user')
    assert.ok(String(delivery.tailBlocks[0]?.content).includes('|dynamic-part'))
  })

  void test('稳定层太短时整段原样下发（不拆块，也没有尾块）', () => {
    const delivery = buildSystemPromptDelivery('short|dynamic', 5)
    assert.equal(delivery.system, 'short|dynamic')
    assert.equal(delivery.leadingMessages.length, 0)
    assert.equal(delivery.tailBlocks.length, 0)
  })
})

void describe('治理度量 · 投影度量与真实投影恒等', () => {
  void test('measureLedgerProjection 与 projectContextLedger 报同一个占用', () => {
    const config = resolveContextGovernanceConfig({ tailProtectTurns: 2 })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, buildPressureHistory(5, 3_000))
    const record = ledger.list()[1]!
    ledger.migrate(record.id, 'EVICTED', 'evict', 10)

    const projected = projectedTokensOf(ledger, config.tailProtectTurns)
    const report = runGovernanceEpoch({
      ledger,
      config: { ...config, epochTriggerPercent: 100, epochTargetPercent: 99 },
      budgetTokens: 200_000,
      epoch: 1,
      at: 1,
    })
    assert.equal(report.beforeTokens, projected)
  })
})
