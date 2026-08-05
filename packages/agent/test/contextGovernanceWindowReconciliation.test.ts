/**
 * 上下文治理 · 量纲统一（治理窗口 ↔ 送核门对账）断言电池。
 *
 * 这一组锁的是 v3 挂账 #4：治理器与送核门原本是两把没有对账的尺子，治理器量的是「账本投影正文
 * 字符 ÷ 密度 / min(模型窗口, cap)」，送核门量的是「tiktoken 实测（含系统提示词与工具 schema）
 * ÷ usableContextWindow」。分子少一块、分母大一块，结果是**治理器在撞门之后才醒**。
 *
 * 四条判决各有一节：
 *  ① G 与门同源——`usableContextWindow` 必须与 `estimateContextUsage` 逐字相同；
 *  ② 对账数学——任意配置组合下「固定开销 + 触发线 < 门红线」；
 *  ③ 配置语义不破——百分比仍是"占 G 的百分比"，默认值不动，变的只是 G 的推导；
 *  ④ 端到端——真编译一条长历史，治理器必须在请求还发得出去的时候就醒。
 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import {
  ContextUsageCompactionPercent,
  estimateContextUsage,
  resolveContextUsageWindow,
} from '../src/agent/context/contextUsage'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { compileProviderSendRequest } from '../src/agent/context/ProviderSendRequest'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import {
  type ContextGovernanceConfigInput,
  DefaultContextGovernanceConfig,
  resolveContextGovernanceConfig,
} from '../src/agent/context/residency/governanceConfig'
import {
  GovernanceHeadroomRatio,
  governanceWakesBeforeSendGate,
  type GovernanceWindowInput,
  resolveGovernanceWindow,
} from '../src/agent/context/residency/governanceWindow'

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text }
}

function toolCallMessage(toolCallId: string, path: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName: 'read_file', input: { path } }],
  } as ModelMessage
}

function toolResultMessage(toolCallId: string, path: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId, toolName: 'read_file', output: { type: 'text', value: `${path}\n${value}` } },
    ],
  } as ModelMessage
}

/** 一轮 = user 指令 + 一对工具调用/结果（结果够大才构成治理压力）。 */
function buildTurn(index: number, resultChars: number): ModelMessage[] {
  const path = `/repo/src/mod-${index}.ts`
  return [
    userMessage(`第 ${index} 轮：读 ${path} 并解释它做了什么`),
    toolCallMessage(`call-${index}`, path),
    toolResultMessage(`call-${index}`, path, 'x'.repeat(resultChars)),
  ]
}

void describe('量纲统一 ① · G 与送核门同源', () => {
  void test('治理窗口的 usable 口径与 estimateContextUsage 逐字相同', () => {
    const config = resolveContextGovernanceConfig()
    const cases: GovernanceWindowInput[] = [
      { modelWindowTokens: 200_000 },
      { modelWindowTokens: 200_000, reservedOutputTokens: 24_000, safetyMarginPercent: 4 },
      { modelWindowTokens: 8_000, safetyMarginPercent: 12 },
      { modelWindowTokens: 1_000_000, reservedOutputTokens: 32_000, safetyMarginPercent: 4 },
      // 窗口缺席：两边必须落到**同一条**默认窗口（128K），不能一边默认、一边回落 cap。
      {},
    ]

    for (const input of cases) {
      const derivation = resolveGovernanceWindow(config, input)
      const estimate = estimateContextUsage('gpt-test', 'system', [userMessage('hi')], {
        contextWindow: input.modelWindowTokens,
        reservedOutputTokens: input.reservedOutputTokens,
        safetyMarginPercent: input.safetyMarginPercent,
      })
      assert.equal(derivation.usableContextWindow, estimate.usableContextWindow)
      assert.equal(derivation.contextWindow, estimate.contextWindow)
    }
  })

  void test('门红线就是 okToSend 的那条线（百分比 × usable）', () => {
    const derivation = resolveGovernanceWindow(resolveContextGovernanceConfig(), {
      modelWindowTokens: 200_000,
      reservedOutputTokens: 24_000,
      safetyMarginPercent: 4,
    })
    assert.equal(
      derivation.sendGateLimitTokens,
      Math.floor((derivation.usableContextWindow * ContextUsageCompactionPercent) / 100)
    )
    assert.equal(
      derivation.usableContextWindow,
      resolveContextUsageWindow({
        contextWindow: 200_000,
        reservedOutputTokens: 24_000,
        safetyMarginPercent: 4,
      }).usableContextWindow
    )
  })

  void test('cap 只当上限：超大窗口锁回 200K，常规窗口由门余量说了算', () => {
    const config = resolveContextGovernanceConfig()
    const huge = resolveGovernanceWindow(config, {
      modelWindowTokens: 1_000_000,
      reservedOutputTokens: 32_000,
      safetyMarginPercent: 4,
    })
    assert.equal(huge.windowTokens, config.cap)
    assert.equal(huge.source, 'cap')

    const normal = resolveGovernanceWindow(config, {
      modelWindowTokens: 200_000,
      reservedOutputTokens: 24_000,
      safetyMarginPercent: 4,
      fixedOverheadTokens: 15_000,
    })
    assert.equal(normal.source, 'send-gate')
    assert.ok(normal.windowTokens < config.cap)
    assert.equal(
      normal.windowTokens,
      Math.floor((normal.sendGateLimitTokens - 15_000) * GovernanceHeadroomRatio)
    )
  })
})

void describe('量纲统一 ② · 对账数学（治理器必先于撞门醒来）', () => {
  /**
   * 钉死的关系：`固定开销 + epochTriggerPercent% × G < 门红线`。
   *
   * 语义就是"账本正文一旦涨到治理触发线，请求仍在门内"。全组合扫一遍而不是挑几个点，
   * 是因为病灶本来就藏在边角配置里（触发线配到 100、窗口极小、开销极大）。
   */
  void test('任意配置组合下触发线严格落在门红线之下', () => {
    const windows = [8_000, 32_000, 128_000, 200_000, 1_000_000]
    const overheads = [0, 1_000, 15_000, 60_000]
    const triggers = [1, 35, 70, 99, 100]
    const caps = [1_000, 50_000, 200_000, 10_000_000]
    let checked = 0
    let degenerate = 0

    for (const modelWindowTokens of windows)
      for (const fixedOverheadTokens of overheads)
        for (const epochTriggerPercent of triggers)
          for (const cap of caps)
            for (const tuned of [false, true]) {
              const config = resolveContextGovernanceConfig({ cap, epochTriggerPercent })
              const derivation = resolveGovernanceWindow(config, {
                modelWindowTokens,
                fixedOverheadTokens,
                reservedOutputTokens: tuned ? Math.floor(modelWindowTokens * 0.12) : undefined,
                safetyMarginPercent: tuned ? 4 : undefined,
              })
              checked += 1
              // 唯一合法的例外：固定开销本身已经撑破门，这时任何账本内容都发不出去。
              if (derivation.headroomTokens <= 0) {
                degenerate += 1
                assert.equal(derivation.source, 'floor')
                assert.equal(derivation.windowTokens, 1)
                continue
              }

              assert.ok(
                governanceWakesBeforeSendGate(config, derivation),
                `触发线未落在门红线之下：window=${modelWindowTokens} overhead=${fixedOverheadTokens} trigger=${epochTriggerPercent} cap=${cap} tuned=${tuned}`
              )
              assert.ok(derivation.windowTokens <= Math.max(1, Math.floor(config.cap)))
            }

    assert.ok(checked > 300)
    // 电池必须真的走过退化分支，否则"例外"那条断言等于没测。
    assert.ok(degenerate > 0)
  })

  void test('目标水位也在门内：epoch 压到目标线时请求必然发得出去', () => {
    const config = resolveContextGovernanceConfig()
    const derivation = resolveGovernanceWindow(config, {
      modelWindowTokens: 200_000,
      reservedOutputTokens: 24_000,
      safetyMarginPercent: 4,
      fixedOverheadTokens: 12_000,
    })
    const targetTokens = (config.epochTargetPercent / 100) * derivation.windowTokens
    assert.ok(derivation.fixedOverheadTokens + targetTokens < derivation.sendGateLimitTokens)
  })

  void test('折扣系数严格小于 1：触发线配到 100% 也不会与门红线重合', () => {
    assert.ok(GovernanceHeadroomRatio < 1)
    const config = resolveContextGovernanceConfig({ epochTriggerPercent: 100 })
    const derivation = resolveGovernanceWindow(config, { modelWindowTokens: 128_000 })
    assert.equal(config.epochTriggerPercent, 100)
    assert.ok(governanceWakesBeforeSendGate(config, derivation))
  })
})

void describe('量纲统一 ③ · 配置语义不破', () => {
  void test('触发/目标水位默认值与百分比语义原样保留', () => {
    assert.equal(DefaultContextGovernanceConfig.epochTriggerPercent, 70)
    assert.equal(DefaultContextGovernanceConfig.epochTargetPercent, 40)
    assert.equal(DefaultContextGovernanceConfig.cap, 200_000)
    assert.deepEqual(resolveContextGovernanceConfig(), DefaultContextGovernanceConfig)
  })

  void test('百分比仍然是"占 G 的百分比"：改触发线不改 G，改窗口口径才改 G', () => {
    const window: GovernanceWindowInput = {
      modelWindowTokens: 200_000,
      reservedOutputTokens: 24_000,
      safetyMarginPercent: 4,
      fixedOverheadTokens: 10_000,
    }
    const base = resolveGovernanceWindow(resolveContextGovernanceConfig(), window)
    const inputs: ContextGovernanceConfigInput[] = [
      { epochTriggerPercent: 20 },
      { epochTargetPercent: 10 },
      { minEpochSavingPercent: 50 },
    ]
    for (const input of inputs) {
      assert.equal(
        resolveGovernanceWindow(resolveContextGovernanceConfig(input), window).windowTokens,
        base.windowTokens
      )
    }
    assert.ok(
      resolveGovernanceWindow(resolveContextGovernanceConfig(), {
        ...window,
        reservedOutputTokens: 60_000,
      }).windowTokens < base.windowTokens
    )
  })
})

void describe('量纲统一 ④ · 端到端：治理器先醒，门后红', () => {
  /**
   * 真编译一条不断增长的历史（含系统提示词与工具 schema 预留），逐轮记录
   * 「送核门百分比」与「本轮是否跑了 epoch」。
   *
   * 病灶形态是：门先红（okToSend=false）而治理器一次都没醒。所以断言两条——
   *  ① 至少有一轮在**门还绿着**的时候跑出了 applied 的 epoch；
   *  ② 第一次 applied 的 epoch 发生时，那一轮请求仍然是可发送的。
   */
  void test('长历史增长过程中，epoch 在送核门变红之前就已经跑过', async () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)
    const history: ModelMessage[] = []
    const systemPrompt = `你是 VelarOS 的执行体。${'规则说明。'.repeat(400)}`
    let firstAppliedTurn = -1
    let firstAppliedOkToSend = false
    let firstBlockedTurn = -1

    for (let turn = 0; turn < 24; turn += 1) {
      history.push(...buildTurn(turn, 6_000))
      const compiled = await compileProviderSendRequest(
        {
          sessionId: 'reconciliation-e2e',
          rawHistoryMessages: [...history],
          phase: 'stream',
          model: 'gpt-test',
          systemPrompt,
          contextWindow: 32_000,
          skipUserTextPersistence: true,
          contextUsageOptions: {
            contextWindow: 32_000,
            reservedOutputTokens: 3_840,
            safetyMarginPercent: 4,
            extraEstimatedChars: 12_000,
            extraEstimatedTokens: 3_000,
          },
        },
        compiler
      )
      if (compiled.governanceEpoch?.applied && firstAppliedTurn < 0) {
        firstAppliedTurn = turn
        firstAppliedOkToSend = compiled.decision.okToSend
      }
      if (!compiled.decision.okToSend && firstBlockedTurn < 0) firstBlockedTurn = turn
      if (firstAppliedTurn >= 0 && firstBlockedTurn >= 0) break
    }

    assert.ok(firstAppliedTurn >= 0, '整条增长历史里治理器一次都没醒')
    assert.ok(firstAppliedOkToSend, '第一次 epoch 发生时请求已经发不出去了（治理器醒得太晚）')
    assert.ok(
      firstBlockedTurn < 0 || firstAppliedTurn < firstBlockedTurn,
      `治理器（第 ${firstAppliedTurn} 轮）没有先于送核门（第 ${firstBlockedTurn} 轮）醒来`
    )
  })

  void test('编译期报告自带窗口推导，且与送核门的 usable 对得上', async () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)
    const history: ModelMessage[] = []
    for (let turn = 0; turn < 6; turn += 1) history.push(...buildTurn(turn, 4_000))

    const compiled = await compileProviderSendRequest(
      {
        sessionId: 'reconciliation-report',
        rawHistoryMessages: history,
        phase: 'stream',
        model: 'gpt-test',
        systemPrompt: '系统提示词'.repeat(200),
        contextWindow: 64_000,
        skipUserTextPersistence: true,
        contextUsageOptions: {
          contextWindow: 64_000,
          reservedOutputTokens: 7_680,
          safetyMarginPercent: 4,
          extraEstimatedChars: 8_000,
          extraEstimatedTokens: 2_000,
        },
      },
      compiler
    )
    const window = compiled.governanceEpoch?.window
    assert.ok(window, 'epoch 报告没带窗口推导')
    assert.equal(window.usableContextWindow, compiled.estimate.usableContextWindow)
    assert.equal(compiled.governanceEpoch?.budgetTokens, window.windowTokens)
    // 固定开销真的被算进去了：系统提示词 + 工具 schema 预留不可能是 0。
    assert.ok(window.fixedOverheadTokens >= 2_000)
    assert.ok(window.windowTokens < window.sendGateLimitTokens)
  })
})
