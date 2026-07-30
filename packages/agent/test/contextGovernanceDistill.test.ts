/**
 * 上下文治理 v2 · B2 断言电池（I2 LLM 蒸馏 + adaptive 档）。
 *
 * 全部确定性：蒸馏器是注入的假实现，时序靠 `whenDistillSettled()` 而不是 sleep，
 * 超时用毫秒级 `timeoutMs`（假蒸馏器永不 resolve，所以没有竞态窗口）。
 *
 * 五条主线：
 *  ① 规划判据（档位 / 目标已达标 / 无蒸馏器 / 并发 / adaptive 三判据边界）；
 *  ② 异步纪律（回合不等蒸馏、产物在**下一个** epoch 边界才落地）；
 *  ③ 验证与回落（锚点缺失 / 不更短 / 超时 / 异常一律回落 I1 骨架）；
 *  ④ 护栏（输入字符上限切段、每 epoch 段数上限、并发 1、代数作废）；
 *  ⑤ 产物形态（锚点行与召回行**机械生成**，不靠模型记）。
 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import {
  ContextGovernanceSession,
  ContextGovernanceSessionRegistry,
} from '../src/agent/context/residency/ContextGovernanceSession'
import {
  type ContextDistiller,
  type ContextDistillInput,
  extractDistilledBody,
  isContextDistillText,
  planContextDistillation,
  resolveDistillGate,
  validateDistilledBody,
} from '../src/agent/context/residency/distill'
import {
  type ContextGovernanceConfigInput,
  resolveContextGovernanceConfig,
} from '../src/agent/context/residency/governanceConfig'
import { ingestHistoryIntoLedger } from '../src/agent/context/residency/ingest'
import { InMemoryContextMigrationEventSink } from '../src/agent/context/residency/migrationLog'
import { measureLedgerProjection } from '../src/agent/context/residency/projection'
import { ContextResidencyLedger } from '../src/agent/context/residency/ResidencyLedger'

/**
 * 治理窗口刻意开小（20K）。
 *
 * 判据里的"缺口占 G 的百分点"是相对量：拿 200K 窗口去测一段一万字的历史，缺口只有零点几个
 * 百分点，adaptive 判据永远不会被触发到边界上——那样的电池测的是"数字太小"，不是策略。
 */
const BudgetTokens = 20_000

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text }
}

function assistantMessage(text: string): ModelMessage {
  return { role: 'assistant', content: text }
}

/**
 * 造一段"能活到 I2 面前"的叙事历史。
 *
 * 两个刻意的性质：
 *  - **锚点密度落在 (2, 6] 区间**：低于 2 会被 I0 的低密度档当场逐出（那批轮不到蒸馏），
 *    高于 6 则 adaptive 的价值密度判据会否掉。这不是测试技巧，是两档器械的真实分工带。
 *  - 每条足够长：段落要过 `minSegmentChars` 与 `minNarrativeChars`。
 */
function buildNarrativeHistory(turns: number, charsPerTurn: number): ModelMessage[] {
  const history: ModelMessage[] = []
  // 每条 ~1000 字符里放 4 个锚点（密度 4/千字符）：I0 不收，adaptive 收。
  const filler = '这里是一段没有硬事实的过程叙述，只讲经过不讲结论。'.repeat(
    Math.ceil(charsPerTurn / 24)
  )
  for (let index = 0; index < turns; index += 1) {
    history.push(
      assistantMessage(
        [
          `第 ${index} 步：改了 src/module-${index}.ts，跑了 bun run check。`,
          filler,
          `退出码 0，涉及 packages/agent/src/entry-${index}.ts 与 tools/lab-${index}.mjs。`,
        ].join('\n')
      )
    )
  }
  history.push(userMessage('继续把驻留账本接进编译器。'))
  return history
}

function distillConfig(overrides: ContextGovernanceConfigInput = {}) {
  return resolveContextGovernanceConfig({
    tailProtectTurns: 0,
    epochTriggerPercent: 2,
    epochTargetPercent: 1,
    minEpochSavingPercent: 1,
    ...overrides,
    instruments: { skeleton: true, distill: 'aux', ...overrides.instruments },
    distillation: {
      minSegmentChars: 2_000,
      timeoutMs: 5_000,
      ...overrides.distillation,
      adaptive: { ...overrides.distillation?.adaptive },
    },
  })
}

/** 一个"听话"的蒸馏器：把所有必须锚点逐字抄回，正文足够短。 */
function createObedientDistiller(
  onCall?: (input: ContextDistillInput) => void
): ContextDistiller {
  return async (input) => {
    onCall?.(input)
    return `任务进展摘要（目标：${input.goalHint ?? '未知'}）。涉及：${input.requiredAnchors.join(' ')}`
  }
}

function createSession(
  config: ReturnType<typeof distillConfig>,
  distiller: Nullable<ContextDistiller>,
  sink?: InMemoryContextMigrationEventSink
): ContextGovernanceSession {
  return new ContextGovernanceSession(config, null, sink ?? null, {
    resolveDistiller: () => distiller,
    sessionId: 'distill-test',
  })
}

void describe('I2 蒸馏 · 规划判据 (§4B / RQ3)', () => {
  void test('档位 off 时从不规划；没有注入蒸馏器时记 no-distiller，不静默假装蒸过', () => {
    const off = createSession(distillConfig({ instruments: { distill: 'off' } }), null)
    off.syncHistory({ messages: buildNarrativeHistory(8, 1_200), at: 1_000 })
    assert.equal(off.governTurn({ at: 1_000, modelWindowTokens: BudgetTokens })?.distill.skipReason, 'off')

    const noDistiller = createSession(distillConfig(), null)
    noDistiller.syncHistory({ messages: buildNarrativeHistory(8, 1_200), at: 1_000 })
    assert.equal(
      noDistiller.governTurn({ at: 1_000, modelWindowTokens: BudgetTokens })?.distill.skipReason,
      'no-distiller'
    )
  })

  void test('机械器械已达标时不花这一跳（target-reached）', () => {
    // 目标水位放到 90%：I0/I1 跑完必然远低于它。
    const session = createSession(
      distillConfig({ epochTriggerPercent: 91, epochTargetPercent: 90 }),
      createObedientDistiller()
    )
    session.syncHistory({ messages: buildNarrativeHistory(8, 1_200), at: 1_000 })

    const report = session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    assert.equal(report?.distill.skipReason, 'target-reached')
    assert.equal(report?.distill.planned, false)
  })

  void test('并发上限 1：上一次还在飞时下一个 epoch 记 in-flight', async () => {
    let release: (value: string) => void = () => {}
    const blocked: ContextDistiller = () =>
      new Promise<string>((resolve) => {
        release = resolve
      })
    const session = createSession(distillConfig(), blocked)
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })

    const first = session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    assert.equal(first?.distill.planned, true)

    const second = session.requestEpoch({ at: 2_000, modelWindowTokens: BudgetTokens })
    assert.equal(second?.distill.skipReason, 'in-flight')

    release('done')
    await session.whenDistillSettled()
  })

  void test('adaptive 判据边界：三项各自卡一次，取值全进报告', () => {
    const ledger = new ContextResidencyLedger()
    const config = distillConfig({ instruments: { skeleton: true, distill: 'adaptive' } })
    const signals = {
      shortfallPercent: 10,
      narrativeChars: 20_000,
      anchorDensityPerKiloChar: 3,
      savingToCostRatio: 4,
    }

    assert.equal(resolveDistillGate('adaptive', config, signals).passed, true)
    // ① 缺口不够大
    assert.equal(
      resolveDistillGate('adaptive', config, { ...signals, shortfallPercent: 1 }).passed,
      false
    )
    // ② 段落太短 / 锚点太密
    assert.equal(
      resolveDistillGate('adaptive', config, { ...signals, narrativeChars: 100 }).passed,
      false
    )
    assert.equal(
      resolveDistillGate('adaptive', config, { ...signals, anchorDensityPerKiloChar: 99 }).passed,
      false
    )
    // ③ 摊销后仍不回本
    assert.equal(
      resolveDistillGate('adaptive', config, { ...signals, savingToCostRatio: 0.1 }).passed,
      false
    )
    // aux / main 档不看这三项——它们的判据就是"机械没达标"。
    assert.equal(
      resolveDistillGate('aux', config, { ...signals, savingToCostRatio: 0 }).passed,
      true
    )
    assert.equal(ledger.list().length, 0)
  })

  void test('adaptive 判据不达标时记 not-worth，且判据取值仍进报告（RQ3 要看的就是这些数）', () => {
    const session = createSession(
      distillConfig({
        instruments: { skeleton: true, distill: 'adaptive' },
        distillation: { adaptive: { minNarrativeChars: 10_000_000 } },
      }),
      createObedientDistiller()
    )
    session.syncHistory({ messages: buildNarrativeHistory(8, 1_200), at: 1_000 })

    const report = session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    assert.equal(report?.distill.skipReason, 'not-worth')
    assert.equal(report?.distill.gate?.passed, false)
    assert.ok((report?.distill.gate?.narrativeChars ?? 0) > 0)
  })
})

void describe('I2 蒸馏 · 异步纪律与产物落地', () => {
  void test('规划它的那个 epoch 不落地；产物在下一个 epoch 边界才应用（P4）', async () => {
    const sink = new InMemoryContextMigrationEventSink()
    const session = createSession(distillConfig(), createObedientDistiller(), sink)
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })

    const planning = session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    assert.equal(planning?.distill.planned, true)
    // 回合**不等**蒸馏：规划的这一轮账上一条产物都没有。
    assert.equal(planning?.distill.appliedProducts, 0)
    assert.equal(planning?.byInstrument.distill, 0)

    await session.whenDistillSettled()

    const applying = session.requestEpoch({ at: 2_000, modelWindowTokens: BudgetTokens })
    assert.equal(applying?.distill.appliedProducts, 1)
    assert.ok((applying?.byInstrument.distill ?? 0) > 0)
    assert.equal(applying?.distill.totals.accepted, 1)

    const summary = session.ledger
      .list()
      .filter((record) => record.kind === 'summary')
      .find((record) => isContextDistillText(String(record.message?.content)))
    assert.ok(summary, '应当落一条蒸馏摘要记录')
    for (const memberId of summary.memberIds) {
      assert.notEqual(session.ledger.residencyOf(memberId), 'INLINE')
    }
    assert.ok(
      sink.listMigrations().some((event) => event.cause === 'distill'),
      '成员迁移的因果必须是 distill —— I1 与 I2 的产物在事件流里可分'
    )
  })

  void test('产物的锚点行与召回行是机械生成的：模型正文里没写，账上照样有', async () => {
    const seen: ContextDistillInput[] = []
    const session = createSession(
      distillConfig(),
      async (input) => {
        seen.push(input)
        // 故意只抄必须锚点，别的什么都不写。
        return `摘要：${input.requiredAnchors.join(' ')}`
      }
    )
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })

    session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    await session.whenDistillSettled()
    session.requestEpoch({ at: 2_000, modelWindowTokens: BudgetTokens })

    assert.equal(seen.length, 1)
    assert.ok(seen[0]!.goalHint?.includes('驻留账本'))
    assert.ok(seen[0]!.requiredAnchors.length > 0)

    const text = String(
      session.ledger
        .list()
        .find((record) => isContextDistillText(String(record.message?.content)))?.message?.content
    )
    assert.ok(text.startsWith('[context-distill epoch='))
    assert.ok(text.includes('- 锚点：'))
  })
})

void describe('I2 蒸馏 · 验证与回落（骨架永远是保底）', () => {
  void test('锚点缺失 → 拒收 → 回落 I1 骨架，迁移因果记 skeleton', async () => {
    const sink = new InMemoryContextMigrationEventSink()
    const session = createSession(distillConfig(), async () => '我把细节都省了。', sink)
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })

    session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    await session.whenDistillSettled()
    const applying = session.requestEpoch({ at: 2_000, modelWindowTokens: BudgetTokens })

    assert.equal(applying?.distill.appliedProducts, 1)
    assert.equal(applying?.distill.appliedByInstrument.distill, 0)
    assert.ok((applying?.distill.appliedByInstrument.skeleton ?? 0) > 0)
    assert.equal(applying?.distill.totals.rejected, 1)
    assert.equal(applying?.distill.totals.accepted, 0)
    assert.ok(sink.listMigrations().some((event) => event.cause === 'skeleton'))
  })

  void test('超时 → 回落骨架并计入 timedOut', async () => {
    const session = createSession(
      distillConfig({ distillation: { timeoutMs: 100, minSegmentChars: 2_000 } }),
      () => new Promise<string>(() => {})
    )
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })

    session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    await session.whenDistillSettled()
    const applying = session.requestEpoch({ at: 2_000, modelWindowTokens: BudgetTokens })

    assert.equal(applying?.distill.totals.timedOut, 1)
    assert.ok((applying?.distill.appliedByInstrument.skeleton ?? 0) > 0)
  })

  void test('端口抛错 → 回落骨架并计入 failed', async () => {
    const session = createSession(distillConfig(), async () => {
      throw new Error('provider down')
    })
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })

    session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    await session.whenDistillSettled()
    const applying = session.requestEpoch({ at: 2_000, modelWindowTokens: BudgetTokens })

    assert.equal(applying?.distill.totals.failed, 1)
    assert.equal(applying?.distill.appliedProducts, 1)
  })

  void test('验证器：空产物 / 不更短 / 缺锚点各判各的', () => {
    const request = { requiredAnchors: ['src/a.ts', 'bun run check'], segmentChars: 100 }
    assert.equal(validateDistilledBody('   ', request), 'empty')
    assert.equal(validateDistilledBody('x'.repeat(200), request), 'not-smaller')
    assert.equal(validateDistilledBody('改了 src/a.ts', request), 'missing-anchors')
    assert.equal(validateDistilledBody('改了 src/a.ts，跑 bun run check', request), null)
  })

  void test('解析容错：Markdown 围栏与 {"summary":…} 都能取出正文', () => {
    assert.equal(extractDistilledBody('```json\n{"summary":"正文"}\n```'), '正文')
    assert.equal(extractDistilledBody('```\n纯文本正文\n```'), '纯文本正文')
    assert.equal(extractDistilledBody('  没包装的正文  '), '没包装的正文')
  })
})

void describe('I2 蒸馏 · 成本护栏', () => {
  void test('输入字符上限切段；每 epoch 段数上限决定规划几次调用', () => {
    const config = distillConfig({
      distillation: { maxInputChars: 3_000, maxSegmentsPerEpoch: 2, minSegmentChars: 1_000 },
    })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, buildNarrativeHistory(12, 1_200))
    const measurement = measureLedgerProjection({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: config.tailProtectTurns, budgetTokens: BudgetTokens },
    })

    const plan = planContextDistillation({
      ledger,
      config,
      budgetTokens: BudgetTokens,
      projectedTokens: measurement.projectedTokens,
      tailProtectedRecordIds: measurement.tailProtectedRecordIds,
      epoch: 1,
      generation: 0,
      hasDistiller: true,
      busy: false,
      pendingCount: 0,
      maxPendingProducts: 4,
    })

    assert.equal(plan.requests.length, 2)
    for (const request of plan.requests) {
      assert.ok(request.segmentChars <= 3_000 + 1_500, '单段不得超出输入上限加最后一条的余量')
      assert.ok(request.requiredAnchors.length <= config.distillation.maxRequiredAnchors)
    }
  })

  void test('账本重建后跨代产物作废，不会把上一段历史的摘要贴到这一段上', async () => {
    const session = createSession(distillConfig(), createObedientDistiller())
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })
    session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    await session.whenDistillSettled()

    // 前缀分叉 → 整本重建 → 代数 +1。
    session.syncHistory({ messages: [userMessage('换了一份完全不同的历史')], at: 2_000 })
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 2_100 })

    const applying = session.requestEpoch({ at: 3_000, modelWindowTokens: BudgetTokens })
    assert.equal(applying?.distill.appliedProducts, 0)
    assert.equal(
      session.ledger.list().some((record) => isContextDistillText(String(record.message?.content))),
      false
    )
  })

  void test('未触发的轮次不吞掉待落地产物：它们等到下一个真开的 epoch 才落地', async () => {
    const session = createSession(distillConfig(), createObedientDistiller())
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })
    session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })
    await session.whenDistillSettled()

    // 水位远未到（窗口开到 200 万 token）：epoch 以 below-trigger 跳过，产物必须原地不动。
    const skipped = session.governTurn({ at: 2_000, modelWindowTokens: 2_000_000 })
    assert.equal(skipped?.skipReason, 'below-trigger')
    assert.equal(skipped?.distill.appliedProducts, 0)

    const applying = session.requestEpoch({ at: 3_000, modelWindowTokens: BudgetTokens })
    assert.equal(applying?.distill.appliedProducts, 1, '产物已付过钱，跳过的 epoch 不该把它丢掉')
  })

  void test('registry 晚绑蒸馏器：注入之前建的会话也能用上（装配顺序不被钉死）', () => {
    const registry = new ContextGovernanceSessionRegistry({
      config: { tailProtectTurns: 0, epochTriggerPercent: 2, epochTargetPercent: 1, minEpochSavingPercent: 1 },
    })
    const session = registry.resolve('late-bind')!
    session.syncHistory({ messages: buildNarrativeHistory(10, 1_200), at: 1_000 })
    assert.equal(
      session.requestEpoch({ at: 1_000, modelWindowTokens: BudgetTokens })?.distill.skipReason,
      'no-distiller'
    )

    registry.setDistiller(createObedientDistiller())
    assert.equal(
      session.requestEpoch({ at: 2_000, modelWindowTokens: BudgetTokens })?.distill.planned,
      true
    )
  })
})
