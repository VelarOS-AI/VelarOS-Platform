/**
 * 上下文治理 v3 · S2 批断言电池（量账与投影）。
 *
 * 四条主线，每条钉死一个已复核的缺陷：
 *  ① **尾保护量纲**（V1）：长自主运行整本落在尾保护窗口内 → 治理永久空转；
 *  ② **渲染即量**（V3/V11/U1/U5/U17/U26/U21）：记账必须等于真实投影，否则达标即停提前收手；
 *  ③ **per-part 投影**（V5/V12）：并行工具结果各拿各的信封、各自可召回、消息不膨胀；
 *  ④ **锚点类别 / 轮序 / 计数**（V13/V8/U18/U20/U23）。
 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { renderContextDashboardText } from '../src/agent/context/residency/dashboard'
import {
  DefaultContextGovernanceConfig,
  resolveContextGovernanceConfig,
} from '../src/agent/context/residency/governanceConfig'
import {
  resolveProjectionBudget,
  runGovernanceEpoch,
} from '../src/agent/context/residency/GovernanceEpoch'
import { ingestHistoryIntoLedger, planHistoryIngest } from '../src/agent/context/residency/ingest'
import { estimateMessageChars } from '../src/agent/context/residency/messageFacts'
import {
  measureLedgerProjection,
  projectContextLedger,
} from '../src/agent/context/residency/projection'
import { ContextResidencyLedger } from '../src/agent/context/residency/ResidencyLedger'
import { buildContextSkeleton } from '../src/agent/context/residency/skeleton'

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

function toolResultMessage(
  results: ReadonlyArray<{ toolCallId: string; toolName: string; value: string }>
): ModelMessage {
  return {
    role: 'tool',
    content: results.map((result) => ({
      type: 'tool-result',
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      output: { type: 'text', value: result.value },
    })),
  } as ModelMessage
}

/** 一条用户指令 + N 轮工具（**没有第二条 user 消息**）——长自主运行的真实形态。 */
function buildAutonomousRun(steps: number, chars: number): ModelMessage[] {
  const history: ModelMessage[] = [userMessage('把整个仓库过一遍并修掉所有红的门')]
  for (let step = 0; step < steps; step += 1) {
    history.push(toolCallMessage(`call-${step}`, 'read_file', { path: `/repo/src/f${step}.ts` }))
    history.push(
      toolResultMessage([
        { toolCallId: `call-${step}`, toolName: 'read_file', value: 'y'.repeat(chars) },
      ])
    )
  }
  return history
}

/** 真实投影的字符数：逐条量真正要发出去的消息（与 `bytes.full` 同一把尺子）。 */
function measureRenderedChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageChars(message), 0)
}

void describe('S2 · 尾保护量纲（V1）', () => {
  void test('单用户轮的长自主运行不再整本免疫：条数闸把候选放出来并真降占用', () => {
    const config = resolveContextGovernanceConfig({ minEpochSavingPercent: 1 })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, buildAutonomousRun(40, 6_000))

    const budget = resolveProjectionBudget(config, 20_000)
    const before = measureLedgerProjection({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget,
    })
    // 全部记录只有 1 个对话轮：按轮算的尾保护会把 81 条全盖住。
    assert.deepEqual(new Set(ledger.list().map((record) => record.turn)), new Set([0]))
    assert.ok(before.tailProtectedRecordIds.size < ledger.list().length)
    assert.equal(before.tailProtectedRecordIds.size, config.tailProtectMaxRecords)

    const report = runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 20_000,
      epoch: 1,
      at: 1_000,
    })
    assert.equal(report.skipReason, null)
    assert.equal(report.applied, true)
    assert.ok(report.savedTokens > 0)
    assert.ok(report.afterPercent < report.beforePercent)
  })

  void test('尾保护是两条判据的交集：条数够但轮数不够的老记录不受保护', () => {
    const config = resolveContextGovernanceConfig({ tailProtectTurns: 1 })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, [
      userMessage('第一轮'),
      assistantMessage('答一'),
      userMessage('第二轮'),
      assistantMessage('答二'),
    ])

    const measurement = measureLedgerProjection({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: resolveProjectionBudget(config, 200_000),
    })
    // 条数闸（默认 16）盖得住全部 4 条，但 tailProtectTurns=1 只保最后一轮。
    assert.deepEqual([...measurement.tailProtectedRecordIds].sort(), ['ctx-r000002', 'ctx-r000003'])
  })
})

void describe('S2 · 渲染即量（V3 / V11 / U1 / U5 / U17 / U26）', () => {
  void test('逐出大参数 tool-call 后，报告的 afterTokens 与真实投影一致', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
      instruments: { skeleton: false, distill: 'off' },
    })
    const ledger = new ContextResidencyLedger({ config })
    const history: ModelMessage[] = [userMessage('批量改文件')]
    for (let index = 0; index < 8; index += 1) {
      history.push(
        toolCallMessage(`call-${index}`, 'ws_edit', {
          path: `/repo/src/m${index}.ts`,
          content: 'z'.repeat(8_000),
        })
      )
      history.push(
        toolResultMessage([{ toolCallId: `call-${index}`, toolName: 'ws_edit', value: 'ok' }])
      )
    }
    ingestHistoryIntoLedger(ledger, history)

    const report = runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 20_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })
    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: resolveProjectionBudget(config, 20_000),
    })

    // tool-call 冷驻留逐字保留 input（配对不可破），所以真实占用必须仍然很大——
    // 按墓碑常量记账时这里会低估 4 倍以上。
    const realChars = measureRenderedChars(projected.messages)
    assert.equal(projected.stats.projectedChars, realChars)
    assert.equal(report.afterTokens, projected.stats.projectedTokens)
    assert.ok(report.afterTokens * 4 > 8_000 * 8 * 0.9, '大参数 tool-call 的占用不该凭空消失')
  })

  void test('墓碑与摘录都按真实渲染长度记账（含信封与 anchors 开销）', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      admission: { inlineMaxChars: 1_000 },
    })
    const ledger = new ContextResidencyLedger({ config })
    const record = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage([
        {
          toolCallId: 'call-1',
          toolName: 'read_file',
          value: `见 /repo/src/a.ts /repo/src/b.ts 与 bun run check 的输出：${'w'.repeat(4_000)}`,
        },
      ]),
      createdAt: 1,
      turn: 0,
      toolArgs: { path: '/repo/src/a.ts' },
    }).record

    const excerptProjection = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    assert.equal(
      excerptProjection.stats.projectedChars,
      measureRenderedChars(excerptProjection.messages)
    )
    // 信封与 JSON 二次转义都要进账：按摘录原文长度记会系统性低估。
    assert.ok(excerptProjection.stats.projectedChars > record.bytes.excerpt)

    ledger.migrate(record.id, 'EVICTED', 'evict', 2)
    const tombstoneProjection = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    assert.equal(
      tombstoneProjection.stats.projectedChars,
      measureRenderedChars(tombstoneProjection.messages)
    )
    assert.ok(
      tombstoneProjection.stats.projectedChars > 200,
      '墓碑信封带 anchors，远不止一行 70 字符'
    )
  })

  void test('dashboard 报的持仓等于真发出去的字节（U21 / v3 · R1）', () => {
    // 不变量没变：dashboard 报的必须是**有效**驻留态下的真实占用，否则模型据它判断"撑不撑得住"
    // 就是被骗（U21：300K 的 user 消息曾被报成 48k）。变的是兑现方式——v3 · R1 之前尾保护会把
    // 窗口内的 EXCERPT 记录强拉回全文渲染，dashboard 必须跟着按全文报；R1 之后窗口内外渲染一致
    // （尾保护只管"治理器不得再降"），有效驻留态恒等于声明态，dashboard 也就不必再知道谁在窗口里。
    const config = resolveContextGovernanceConfig({ admission: { inlineMaxChars: 1_000 } })
    const ledger = new ContextResidencyLedger({ config })
    ledger.append({
      kind: 'user',
      message: userMessage('x'.repeat(300_000)),
      createdAt: 1,
      turn: 0,
    })

    const budget = resolveProjectionBudget(config, 200_000)
    const projection = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget,
    })
    const text = renderContextDashboardText({
      epoch: 0,
      stats: ledger.stats(),
      records: ledger.list(),
      residency: ledger.residencyVector(),
      projectedTokens: projection.stats.projectedTokens,
      budgetTokens: 200_000,
    })

    // 这条 user 记录超 48K 安全阀 → 声明态 EXCERPT，窗口内也照 EXCERPT 渲染。
    assert.ok(text.includes('inline=0 excerpt=1'), text)
    const renderedChars = measureRenderedChars(projection.messages)
    assert.equal(projection.stats.projectedChars, renderedChars)
    assert.ok(text.includes(`=${Math.round(renderedChars / 1000)}k`), text)
    // 300K 全文没有被逐字发出去——安全阀不再被尾保护旁路（R1 的附带后果）。
    assert.ok(renderedChars < 60_000, `安全阀失效：实发 ${renderedChars} 字符`)
  })
})

void describe('S2 · 并行工具结果 per-part 投影（V5 / V12）', () => {
  void test('三个并行结果各拿各的信封、各自可召回，消息不因"摘录"而变大', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      admission: { inlineMaxChars: 24_000 },
    })
    const ledger = new ContextResidencyLedger({ config })
    const message = toolResultMessage([
      { toolCallId: 'c1', toolName: 'read_file', value: `A${'a'.repeat(10_000)}` },
      { toolCallId: 'c2', toolName: 'web_read', value: `B${'b'.repeat(10_000)}` },
      { toolCallId: 'c3', toolName: 'inspect_page', value: `C${'c'.repeat(10_000)}` },
    ])
    const record = ledger.append({ kind: 'tool-result', message, createdAt: 1, turn: 0 }).record
    assert.equal(record.admittedResidency, 'EXCERPT')
    assert.equal(record.toolParts.length, 3)

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    const parts = (projected.messages[0]!.content as Array<Record<string, unknown>>).map(
      (part) => JSON.parse(String((part.output as Record<string, unknown>).value)) as Record<string, unknown>
    )
    assert.deepEqual(
      parts.map((envelope) => envelope.toolCallId),
      ['c1', 'c2', 'c3']
    )
    assert.deepEqual(
      parts.map((envelope) => envelope.toolName),
      ['read_file', 'web_read', 'inspect_page']
    )
    // 每份结果的摘录里必须是它自己的正文，不是第一份的复制品。
    assert.ok(String(parts[1]!.excerpt).startsWith('B'))
    assert.ok(String(parts[2]!.excerpt).startsWith('C'))
    // "摘录"必须真的更小：共用一个信封时实测会把消息放大到原文的 2.4 倍。
    assert.ok(estimateMessageChars(projected.messages[0]!) < estimateMessageChars(message))
    assert.equal(projected.stats.projectedChars, measureRenderedChars(projected.messages))

    ledger.migrate(record.id, 'EVICTED', 'evict', 2)
    const tombstoned = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    const refs = (tombstoned.messages[0]!.content as Array<Record<string, unknown>>).map((part) => {
      const envelope = JSON.parse(
        String((part.output as Record<string, unknown>).value)
      ) as Record<string, unknown>
      return envelope.ref
    })
    assert.deepEqual(refs, ['c1', 'c2', 'c3'])
  })

  void test('多结果消息不参与语义去重：不会拿第一份的目标把整条判过时', () => {
    const ledger = new ContextResidencyLedger()
    const first = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage([
        { toolCallId: 'c1', toolName: 'inspect_page', value: 'v1' },
      ]),
      createdAt: 1,
      turn: 0,
      toolArgs: { url: 'https://example.com/docs' },
    })
    const second = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage([
        { toolCallId: 'c2', toolName: 'inspect_page', value: 'v2' },
        { toolCallId: 'c3', toolName: 'read_file', value: 'unrelated' },
      ]),
      createdAt: 2,
      turn: 0,
      toolArgs: { url: 'https://example.com/docs' },
    })

    assert.equal(first.record.dedupeKey !== null, true)
    assert.equal(second.record.dedupeKey, null)
    assert.deepEqual(second.supersededIds, [])
  })
})

void describe('S2 · 锚点类别 / 轮序 / 计数（V13 / V8 / U18 / U20 / U23）', () => {
  void test('骨架「文件」栏只收路径锚，版本号不再把真实路径顶掉', () => {
    const ledger = new ContextResidencyLedger()
    ingestHistoryIntoLedger(ledger, [
      userMessage('升级依赖'),
      assistantMessage(
        [
          '把 0.24.0 升到 0.24.2、18.2.0 升到 19.0.1、3.23.8 升到 3.24.1，',
          '改了 src/main/index.ts、src/main/agent/loop.ts、src/renderer/App.tsx、',
          'packages/core/src/utils/ForgivingSchema.ts、docs/readme.md 与 apps/desktop/package.json，',
          '跑 bun run check 通过 exit code 0。',
        ].join('')
      ),
    ])

    const skeleton = buildContextSkeleton({ members: ledger.list(), epoch: 1 })!
    const filesLine = skeleton.text.split('\n').find((line) => line.startsWith('- 文件：'))!
    assert.ok(filesLine.includes('src/main/index.ts'), filesLine)
    assert.ok(!/\|\s*\d+\.\d+\.\d+/.test(filesLine), `版本号不该进文件栏: ${filesLine}`)
    assert.ok(skeleton.text.includes('- 命令：bun run check'))
    // 并集按类别优先序：路径 → 命令 → 标识符 → 数字。
    assert.equal(skeleton.anchors[0]?.kind, 'path')
    assert.equal(skeleton.anchors.at(-1)?.kind, 'number')
  })

  void test('增量摄入与整批摄入对同一份历史给出同一套轮序', () => {
    const history = [
      userMessage('u1'),
      assistantMessage('a1'),
      userMessage('u2'),
      assistantMessage('a2'),
    ]
    const batch = planHistoryIngest(history).inputs.map((input) => input.turn)

    const incremental: number[] = []
    let startTurn = 0
    let turnBoundarySeen = false
    for (const message of history) {
      const plan = planHistoryIngest([message], { startTurn, turnBoundarySeen })
      incremental.push(plan.inputs[0]!.turn)
      startTurn = plan.nextTurn
      turnBoundarySeen = plan.turnBoundarySeen
    }

    assert.deepEqual(batch, [0, 0, 1, 1])
    assert.deepEqual(incremental, batch)
  })

  void test('migrationCount 等于真实迁移条数：骨架成员不再双计', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const ledger = new ContextResidencyLedger({ config })
    const prose = '这是一段没有硬事实的过程叙述。'.repeat(120)
    ingestHistoryIntoLedger(ledger, [
      userMessage('开工'),
      userMessage(`先看看 ${prose}`),
      assistantMessage(`我看完了 ${prose}`),
      userMessage(`再看看 ${prose}`),
      assistantMessage(`还是那样 ${prose}`),
    ])

    const report = runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 1_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })
    const migrated = ledger
      .list()
      .filter((record) => ledger.residencyOf(record.id) !== record.admittedResidency).length
    assert.equal(report.migrationCount, migrated)
  })

  void test('模型请求的 epoch 达标后仍折掉排在低密度候选之后的陈旧快照', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 0,
      minEpochSavingPercent: 1,
      epochTargetPercent: 99,
      instruments: { skeleton: false, distill: 'off' },
    })
    const ledger = new ContextResidencyLedger({ config })
    ingestHistoryIntoLedger(ledger, [
      userMessage('第一轮'),
      // 低密度叙事（score 200 档，排在前面）。
      assistantMessage('这是一段没有硬事实的过程叙述。'.repeat(200)),
      toolCallMessage('c1', 'read_file', { path: '/repo/src/a.ts' }),
      toolResultMessage([{ toolCallId: 'c1', toolName: 'read_file', value: 'a'.repeat(3_000) }]),
      userMessage('第二轮'),
      userMessage('第三轮'),
    ])
    const stale = ledger.list().find((record) => record.kind === 'tool-result')!
    // faultCount 把陈旧快照的排序分抬到低密度候选之后（U20 的触发形态）。
    ledger.recordFault(stale.id, 1)
    ledger.recordFault(stale.id, 2)
    ledger.recordFault(stale.id, 3)
    ledger.recordFault(stale.id, 4)

    runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 200_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })
    assert.equal(ledger.residencyOf(stale.id), 'EVICTED')
  })

  void test('超长工具结果的摘录取输出正文，不是 part 的 JSON 转储', () => {
    const config = resolveContextGovernanceConfig({ admission: { inlineMaxChars: 500 } })
    const ledger = new ContextResidencyLedger({ config })
    const record = ledger.append({
      kind: 'tool-result',
      message: toolResultMessage([
        { toolCallId: 'c1', toolName: 'read_file', value: `HEAD${'p'.repeat(2_000)}TAIL` },
      ]),
      createdAt: 1,
      turn: 0,
    }).record

    assert.ok(record.excerpt!.text.startsWith('HEAD'))
    assert.ok(record.excerpt!.text.endsWith('TAIL'))
    assert.ok(!record.excerpt!.text.includes('"type":"tool-result"'))
  })

  void test('账本段第一条 user 记录（任务陈述）压到水位后仍在投影里', () => {
    const config = resolveContextGovernanceConfig({
      tailProtectTurns: 2,
      minEpochSavingPercent: 1,
      epochTargetPercent: 1,
    })
    const ledger = new ContextResidencyLedger({ config })
    // 任务陈述刻意"长而稀"：短指令锚点密度高、本来就进不了候选，那样的用例证明不了什么。
    const taskStatement = `目标：把 /repo/src/index.ts 接进新链路。${'先按老路子梳一遍，再决定要不要动结构。'.repeat(60)}`
    const history: ModelMessage[] = [userMessage(taskStatement)]
    for (let turn = 0; turn < 8; turn += 1) {
      history.push(assistantMessage('这是一段没有硬事实的过程叙述。'.repeat(80)))
      history.push(userMessage(`继续第 ${turn} 步`))
    }
    ingestHistoryIntoLedger(ledger, history)

    runGovernanceEpoch({
      ledger,
      config,
      budgetTokens: 2_000,
      epoch: 1,
      at: 1_000,
      modelRequested: true,
    })
    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: resolveProjectionBudget(config, 2_000),
    })

    assert.equal(projected.messages[0]?.role, 'user')
    assert.ok(String(projected.messages[0]?.content).includes(taskStatement))
  })
})

void describe('S2 · 尾保护不改渲染 / 前缀稳定（v3 · R1）', () => {
  void test('尾窗内的 EXCERPT 记录逐轮追加：它那条消息逐字不变，投影字节只增不改', () => {
    // 复现形态（评审 R1 探针）：一条 50K 的工具结果准入判 EXCERPT，随后逐条追加小记录。
    // 旧实现里"尾保护窗口内恒 INLINE"，而窗口是「最近 N 轮 ∩ 最近 16 条」——每追加一条就滑一格，
    // 大结果滑出去的那一步，它在 provider 消息里的渲染从全文变成信封（位置固定在前缀中段），
    // 既不产 GovernanceEpochReport 也不落 ContextResidencyMigrationEvent，KV 缓存却当场失效。
    // 实测走势：前 15 次 ledgerFingerprint 恒定、projectedChars 5.0 万，第 16 次起换指纹、掉到 2.6 万。
    const config = resolveContextGovernanceConfig()
    const ledger = new ContextResidencyLedger({ config })
    ledger.append({ kind: 'user', message: userMessage('把这份日志读完'), createdAt: 1, turn: 0 })
    ledger.append({
      kind: 'tool-result',
      message: toolResultMessage([
        { toolCallId: 'call-big', toolName: 'read_file', value: 'y'.repeat(50_000) },
      ]),
      createdAt: 2,
      turn: 0,
      toolArgs: { path: '/repo/build.log' },
    })
    const bigRecord = ledger.list().at(-1)!
    assert.equal(bigRecord.admittedResidency, 'EXCERPT')

    const budget = resolveProjectionBudget(config, 200_000)
    const renderedBig: string[] = []
    const projectedChars: number[] = []
    // 24 步 > 条数闸 16：大结果必然在中途滑出窗口。
    for (let step = 0; step < 24; step += 1) {
      ledger.append({
        kind: 'assistant',
        message: assistantMessage(`第 ${step} 步`),
        createdAt: 10 + step,
        turn: 0,
      })
      const projection = projectContextLedger({
        records: ledger.list(),
        residency: ledger.residencyVector(),
        budget,
      })
      renderedBig.push(JSON.stringify(projection.messages[1]))
      projectedChars.push(projection.stats.projectedChars)
    }

    // 窗口滑动不得改写任何一条已发出去的消息。
    assert.equal(new Set(renderedBig).size, 1, '大结果那条消息在窗口滑出前后必须逐字相同')
    // 只追加不改写 ⇒ 占用单调不减；旧实现在滑出那一步会骤降近一半（= 缓存被自己的保护打掉）。
    for (let index = 1; index < projectedChars.length; index += 1) {
      assert.ok(
        projectedChars[index]! >= projectedChars[index - 1]!,
        `第 ${index} 步投影字节回退：${projectedChars[index - 1]} → ${projectedChars[index]}`
      )
    }
    // 附带后果：50K 原文从第一轮起就没被逐字发出去——安全阀不再被尾保护旁路。
    assert.ok(renderedBig[0]!.includes('__contextRef'))
    assert.ok(
      renderedBig[0]!.length < bigRecord.bytes.full / 2,
      `尾窗内仍在逐字发全文：${renderedBig[0]!.length} / ${bigRecord.bytes.full}`
    )
  })
})

void describe('S2 · 摘录素材与安全阀（v3 · R5）', () => {
  /** 三份并行结果，每份 `chars` 字符。 */
  function parallelToolResults(chars: number): ModelMessage {
    return toolResultMessage([
      { toolCallId: 'c1', toolName: 'read_file', value: 'a'.repeat(chars) },
      { toolCallId: 'c2', toolName: 'web_read', value: 'b'.repeat(chars) },
      { toolCallId: 'c3', toolName: 'inspect_page', value: 'c'.repeat(chars) },
    ])
  }

  void test('每份都不超均分额度时不再假称 EXCERPT：声明态与渲染面一致', () => {
    // 摘录预算按 part 均分（24K / 3 = 8K）。三份各 8K 的结果一份素材都建不出来，而整条消息的
    // JSON 结构与转义开销把它推过 24K 阈值。旧实现照样记 EXCERPT，投影却因为"一个信封都没有"
    // 整条回落全文——账本写着 EXCERPT、发出去的是逐字全文，且记账自洽（residentChars 量的就是
    // 那条全文），所以只表现为"安全阀有时候不生效"，没有任何记账偏差暴露它。
    const config = resolveContextGovernanceConfig()
    const ledger = new ContextResidencyLedger({ config })
    const message = parallelToolResults(8_000)
    // 前提复现：整条越过阈值，但每份都不超均分额度。
    assert.ok(estimateMessageChars(message) > config.admission.inlineMaxChars)
    assert.ok(8_000 <= Math.floor(config.admission.excerptMaxChars / 3))

    const record = ledger.append({ kind: 'tool-result', message, createdAt: 1, turn: 0 }).record
    assert.equal(record.admittedResidency, 'INLINE', '摘不出素材就不该记 EXCERPT')

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    // 发出去的字节一个不变（这条本来就压不动），变的只是账本不再自相矛盾。
    assert.deepEqual(projected.messages[0], message)
  })

  void test('声明 EXCERPT 的记录一定渲染成信封（不变量，不是"通常"）', () => {
    const config = resolveContextGovernanceConfig()
    const ledger = new ContextResidencyLedger({ config })
    const message = parallelToolResults(10_000)
    const record = ledger.append({ kind: 'tool-result', message, createdAt: 1, turn: 0 }).record
    assert.equal(record.admittedResidency, 'EXCERPT')

    const projected = projectContextLedger({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 0 },
    })
    const parts = (projected.messages[0]!.content as Array<Record<string, unknown>>).map((part) =>
      String((part.output as Record<string, unknown>).value)
    )
    assert.equal(parts.length, 3)
    for (const part of parts) assert.ok(part.includes('__contextRef'), part.slice(0, 80))
    assert.ok(estimateMessageChars(projected.messages[0]!) < estimateMessageChars(message))
  })
})

void describe('S2 · 配置三层镜像', () => {
  void test('尾保护条数是可扫参旋钮：越界钳制、0 = 关闭尾保护', () => {
    assert.equal(DefaultContextGovernanceConfig.tailProtectMaxRecords, 16)
    assert.equal(
      resolveContextGovernanceConfig({ tailProtectMaxRecords: -5 }).tailProtectMaxRecords,
      0
    )
    assert.equal(
      resolveContextGovernanceConfig({ tailProtectMaxRecords: 9_999_999 }).tailProtectMaxRecords,
      1_000_000
    )

    const ledger = new ContextResidencyLedger()
    ingestHistoryIntoLedger(ledger, [userMessage('a'), assistantMessage('b')])
    const measurement = measureLedgerProjection({
      records: ledger.list(),
      residency: ledger.residencyVector(),
      budget: { tailProtectTurns: 100, tailProtectMaxRecords: 0 },
    })
    assert.equal(measurement.tailProtectedRecordIds.size, 0)
  })
})
