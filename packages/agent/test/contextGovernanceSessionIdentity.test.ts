/**
 * 上下文治理 v3 · S1（会话身份与生存）断言电池。
 *
 * 这一组锁的都是"治理跨回合状态被悄悄打断"的形态——它们不改变任何一次 epoch 的算法，只保证
 * 账本活到下一轮、活在正确的会话名下、报告用同一把尺子记账：
 *  ① 传输装饰（prompt-cache 断点）不得让账本每个用户轮整本重建；
 *  ② registry 满员时淘汰的必须是最久没用的那个，不是刚建的那个；
 *  ③ 手动 epoch 与自动 epoch 同量纲（窗口 + 字符/token 密度），报告自带量纲与代数；
 *  ④ 子 agent 与父会话不共用账本；
 *  ⑤ 账本重建后陈旧的 `context:distill` 不得被再消费一次；
 *  ⑥ 转交信号只看当前代账本的报告。
 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { compileProviderSendRequest } from '../src/agent/context/ProviderSendRequest'
import {
  ContextGovernanceSession,
  ContextGovernanceSessionRegistry,
} from '../src/agent/context/residency/ContextGovernanceSession'
import { resolveContextGovernanceConfig } from '../src/agent/context/residency/governanceConfig'

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

function hasPromptCacheBreakpoint(message: LooseOptional<ModelMessage>): boolean {
  const velaros = (message?.providerOptions as Record<string, unknown> | undefined)?.velaros
  if (!velaros || typeof velaros !== 'object') return false
  return 'promptCacheBreakpoint' in (velaros as Record<string, unknown>)
}

/** 一段够多轮的压力历史（每轮一条 user + 一对工具调用/结果，路径取绝对形式才构成可重取目标）。 */
function buildPressureHistory(turns: number, resultChars: number): ModelMessage[] {
  const history: ModelMessage[] = []
  for (let index = 0; index < turns; index += 1) {
    history.push(userMessage(`第 ${index} 轮：读 /repo/src/mod-${index}.ts`))
    history.push(
      toolCallMessage(`call-${index}`, 'read_file', { path: `/repo/src/mod-${index}.ts` })
    )
    history.push(
      toolResultMessage(`call-${index}`, 'read_file', `/repo/src/mod-${index}.ts\n${'x'.repeat(resultChars)}`)
    )
  }
  return history
}

void describe('S1 · 传输装饰不重建账本（V10 / U2 / U4）', () => {
  const compileTurn = async (compiler: ProviderRequestCompiler, messages: ModelMessage[]) =>
    compileProviderSendRequest(
      {
        sessionId: 'decoration-1',
        rawHistoryMessages: [...messages],
        phase: 'stream',
        model: 'gpt-test',
        systemPrompt: 'system',
        contextWindow: 200_000,
        skipUserTextPersistence: true,
      },
      compiler
    )

  void test('连着三个用户轮编译，账本只增量追加，一次都不重建', async () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)

    // 一个真实的 ReAct 形态：指令 → 工具往返 → 下一条指令。
    await compileTurn(compiler, [userMessage('第一条指令')])
    await compileTurn(compiler, [
      userMessage('第一条指令'),
      toolCallMessage('call-1', 'read_file', { path: '/repo/a.ts' }),
      toolResultMessage('call-1', 'read_file', 'export const a = 1'),
    ])
    await compileTurn(compiler, [
      userMessage('第一条指令'),
      toolCallMessage('call-1', 'read_file', { path: '/repo/a.ts' }),
      toolResultMessage('call-1', 'read_file', 'export const a = 1'),
      assistantMessage('好的'),
      userMessage('第二条指令'),
    ])

    const session = registry.peek('decoration-1')!
    // 代数 0 = 一次都没整本重建；条数 5 = 每轮只追加了新出的那几条。
    assert.equal(session.generation, 0)
    assert.equal(session.ledger.list().length, 5)
  })

  void test('provider 仍只在最新一条 user 消息上带缓存断点，账本里那份未被装饰', async () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)

    const compiled = await compileTurn(compiler, [
      userMessage('第一条指令'),
      assistantMessage('好的'),
      userMessage('第二条指令'),
    ])

    const [first, , latest] = compiled.providerMessages
    assert.equal(hasPromptCacheBreakpoint(latest), true)
    assert.equal(hasPromptCacheBreakpoint(first), false)

    const records = registry.peek('decoration-1')!.ledger.list()
    assert.equal(records.every((record) => !hasPromptCacheBreakpoint(record.message)), true)
  })
})

void describe('S1 · registry 容量淘汰（V7）', () => {
  void test('满员时淘汰最久没用的会话，不是刚建的那个', () => {
    const registry = new ContextGovernanceSessionRegistry({ maxTrackedSessions: 2 })
    registry.resolve('a')!.syncHistory({ messages: [userMessage('a')], at: 1 })
    registry.resolve('b')!.syncHistory({ messages: [userMessage('b')], at: 2 })
    registry.resolve('c')!.syncHistory({ messages: [userMessage('c')], at: 3 })

    assert.equal(registry.peek('c')?.ledger.list().length, 1)
    assert.equal(registry.peek('b')?.ledger.list().length, 1)
    assert.equal(registry.peek('a'), null)
  })

  void test('resolve 命中会刷新最近使用序：常用会话不会被后来者挤掉', () => {
    const registry = new ContextGovernanceSessionRegistry({ maxTrackedSessions: 2 })
    const a = registry.resolve('a')!
    a.syncHistory({ messages: [userMessage('a')], at: 1 })
    registry.resolve('b')!.syncHistory({ messages: [userMessage('b')], at: 2 })
    // a 又被用了一次 → b 变成最久没用的那个。
    assert.equal(registry.resolve('a'), a)
    registry.resolve('c')!.syncHistory({ messages: [userMessage('c')], at: 3 })

    assert.equal(registry.peek('a'), a)
    assert.equal(registry.peek('b'), null)
  })
})

void describe('S1 · 手动 epoch 的量纲与记账（V9 / U11）', () => {
  void test('registry.requestEpoch 不给量纲时回落最近一次编译的窗口与密度', async () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)
    const compiled = await compileProviderSendRequest(
      {
        sessionId: 'dimension-1',
        rawHistoryMessages: buildPressureHistory(4, 2_000),
        phase: 'stream',
        model: 'gpt-test',
        systemPrompt: 'system',
        // 32K 窗口：手动 epoch 若丢掉窗口口径，会退化成 `estimateContextUsage` 的默认 128K 窗口。
        contextWindow: 32_000,
        skipUserTextPersistence: true,
      },
      compiler
    )
    const compiledCharsPerToken = compiled.governanceEpoch?.charsPerToken

    const manual = registry.requestEpoch('dimension-1')
    // 量纲统一批改判：G 不再是 min(窗口, cap)，而是送核门余量的折扣值。这条断言要钉的仍然是
    // 「手动 epoch 用的是**最近一次编译**的那把尺子」，所以直接与编译期报告对齐。
    assert.equal(manual?.budgetTokens, compiled.governanceEpoch?.budgetTokens)
    assert.equal(manual?.window?.contextWindow, 32_000)
    assert.ok((manual?.budgetTokens ?? 0) < 32_000)
    assert.equal(manual?.charsPerToken, compiledCharsPerToken)
    assert.equal(manual?.source, 'host-request')
  })

  void test('显式传进来的量纲优先于回落值', () => {
    const session = new ContextGovernanceSession(resolveContextGovernanceConfig(), null, null)
    session.syncHistory({ messages: buildPressureHistory(3, 1_000), at: 1_000 })
    session.governTurn({ at: 1_000, modelWindowTokens: 32_000, charsPerToken: 2 })

    const manual = session.requestEpoch({ at: 2_000, modelWindowTokens: 8_000, charsPerToken: 1.5 })
    // 8_000 → usable 8_000（无预算调优）→ 门红线 6_400 → 零固定开销 → G = floor(6_400 × 0.9)。
    assert.equal(manual?.window?.contextWindow, 8_000)
    assert.equal(manual?.budgetTokens, 5_760)
    assert.equal(manual?.charsPerToken, 1.5)
  })

  void test('报告带账本代数：重建之后跑出来的 epoch 属于新一代', () => {
    const session = new ContextGovernanceSession(resolveContextGovernanceConfig(), null, null)
    session.syncHistory({ messages: buildPressureHistory(3, 1_000), at: 1_000 })
    assert.equal(session.governTurn({ at: 1_000, modelWindowTokens: 32_000 })?.ledgerGeneration, 0)

    session.syncHistory({ messages: buildPressureHistory(2, 900), at: 2_000 })
    assert.equal(session.governTurn({ at: 2_000, modelWindowTokens: 32_000 })?.ledgerGeneration, 1)
  })
})

void describe('S1 · 子 agent 不与父会话共用账本（U12）', () => {
  void test('同一 sessionId 下不同 governanceSessionId 各自一本账本，谁也不重建谁', () => {
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)
    const shared = {
      model: 'gpt-test',
      systemPrompt: 'system',
      sessionId: 'parent-1',
      contextWindow: 200_000,
    }

    compiler.compile({ ...shared, messages: [userMessage('父：查一下 /repo/a.ts')] })
    compiler.compile({
      ...shared,
      governanceSessionId: 'sub-agent:parent-1:scout:1',
      messages: [userMessage('子：只读 /repo/b.ts')],
    })
    compiler.compile({
      ...shared,
      messages: [
        userMessage('父：查一下 /repo/a.ts'),
        toolCallMessage('call-p1', 'read_file', { path: '/repo/a.ts' }),
        toolResultMessage('call-p1', 'read_file', 'export const a = 1'),
      ],
    })

    const parent = registry.peek('parent-1')!
    const child = registry.peek('sub-agent:parent-1:scout:1')!
    assert.equal(parent.generation, 0)
    assert.equal(parent.ledger.list().length, 3)
    assert.equal(child.generation, 0)
    assert.equal(child.ledger.list().length, 1)
  })
})

void describe('S1 · 重建后的陈旧 epoch 请求与转交信号（U19 / U34 / R3）', () => {
  /** 一对 `context:distill` 调用/结果；`toolCallId` 就是这条请求的跨代稳定身份。 */
  function distillPairOf(toolCallId: string): ModelMessage[] {
    return [
      toolCallMessage(toolCallId, 'context:distill', { facts: ['x'] }),
      toolResultMessage(toolCallId, 'context:distill', '{"distilled":true}'),
    ]
  }

  const distillPair = distillPairOf('call-distill')

  void test('账本重建后，历史里那条旧的 context:distill 不再被消费一次', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const session = new ContextGovernanceSession(config, null, null)
    session.syncHistory({
      messages: [...buildPressureHistory(3, 2_000), ...distillPair],
      at: 1_000,
    })
    assert.equal(session.governTurn({ at: 1_000, modelWindowTokens: 200_000 })?.trigger, 'model-request')

    // 历史前缀分叉（回滚 / 编辑 / 结构自愈）→ 整本重建，那条旧请求原样回到账本里。
    session.syncHistory({
      messages: [userMessage('换了个开头'), ...buildPressureHistory(2, 2_000), ...distillPair],
      at: 2_000,
    })
    const afterRebuild = session.governTurn({ at: 2_000, modelWindowTokens: 200_000 })
    assert.equal(afterRebuild?.trigger, null)
    assert.equal(afterRebuild?.skipReason, 'below-trigger')
  })

  void test('同一次 sync 里既重建又带来新请求：新的 context:distill 仍被消费（v3 · R3）', () => {
    // U19 的旧修法是"重建后把消费游标对齐当前账本尾"，而对齐发生在新尾巴已经 append 之后 ——
    // 于是**同一次 syncHistory 里刚到达的新请求**也被一并标成已消费：模型"这一阶段我消化完了"
    // 的声明被永久吞掉（记录 id 已写进游标，下一轮也不会再触发），只剩水位路径兜底。
    // 触发条件毫不刁钻：上游 sanitize / 结构自愈改写了更早的消息 → 判 rebuilt，而这一轮模型
    // 恰好调了 context:distill。改记 toolCallId 之后，"旧请求重摄入"与"新请求"在结构上就分开了。
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const session = new ContextGovernanceSession(config, null, null)
    session.syncHistory({ messages: buildPressureHistory(3, 2_000), at: 1_000 })
    assert.equal(session.governTurn({ at: 1_000, modelWindowTokens: 200_000 })?.trigger, null)

    // 前缀分叉（重建）+ 尾部带一条**全新**的 context:distill。
    session.syncHistory({
      messages: [
        userMessage('上游把开头改写了'),
        ...buildPressureHistory(2, 2_000),
        ...distillPairOf('call-distill-fresh'),
      ],
      at: 2_000,
    })
    const afterRebuild = session.governTurn({ at: 2_000, modelWindowTokens: 200_000 })
    assert.equal(afterRebuild?.trigger, 'model-request')
    assert.equal(afterRebuild?.source, 'model-tool')

    // 消费仍然只此一次：下一轮不带新请求就不再强开。
    session.syncHistory({
      messages: [
        userMessage('上游把开头改写了'),
        ...buildPressureHistory(2, 2_000),
        ...distillPairOf('call-distill-fresh'),
        userMessage('继续'),
      ],
      at: 3_000,
    })
    assert.equal(session.governTurn({ at: 3_000, modelWindowTokens: 200_000 })?.trigger, null)
  })

  void test('转交信号只看当前代账本的报告：重建后不再拿上一代的低收益布防', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 100,
      // 条数闸也放到不咬合：本用例要的是"整本都在尾保护里"这一极端形态，两条判据都得盖住。
      tailProtectMaxRecords: 1_000_000,
      epochTriggerPercent: 5,
      epochTargetPercent: 4,
      minEpochSavingPercent: 10,
    })
    const session = new ContextGovernanceSession(config, null, null)
    session.syncHistory({ messages: buildPressureHistory(20, 6_000), at: 1_000 })
    session.governTurn({ at: 1_000, modelWindowTokens: 20_000 })
    session.governTurn({ at: 2_000, modelWindowTokens: 20_000 })
    assert.equal(session.handoffSignal().armed, true)

    session.syncHistory({ messages: [userMessage('新开一段')], at: 3_000 })
    const afterRebuild = session.handoffSignal()
    assert.equal(afterRebuild.armed, false)
    assert.equal(afterRebuild.recentSavingPercents.length, 0)
  })

  void test('转交阈值走配置面：连击数可扫参（默认 2 次的那条线不再写死在代码里）', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 100,
      // 条数闸也放到不咬合：本用例要的是"整本都在尾保护里"这一极端形态，两条判据都得盖住。
      tailProtectMaxRecords: 1_000_000,
      epochTriggerPercent: 5,
      epochTargetPercent: 4,
      minEpochSavingPercent: 10,
      handoff: { lowSavingStreak: 3 },
    })
    const session = new ContextGovernanceSession(config, null, null)
    session.syncHistory({ messages: buildPressureHistory(20, 6_000), at: 1_000 })
    session.governTurn({ at: 1_000, modelWindowTokens: 20_000 })
    session.governTurn({ at: 2_000, modelWindowTokens: 20_000 })

    // 默认阈值下这里已经 armed，连击数抬到 3 之后还差一次。
    assert.equal(session.handoffSignal().armed, false)
    session.governTurn({ at: 3_000, modelWindowTokens: 20_000 })
    assert.equal(session.handoffSignal().armed, true)
    assert.equal(session.config.handoff.occupancyPercent, 35)
  })
})
