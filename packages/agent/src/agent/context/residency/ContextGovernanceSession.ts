/**
 * 会话级治理器（Governor 的宿主形态）——账本的跨回合家。
 *
 * 账本必须跨回合活着：`ProviderRequestCompiler` 每轮新编译一次，若每轮重建账本，驻留态向量、
 * faultCount、epoch 号全部归零，治理退化成"每轮重新想一遍"。所以状态收在按 sessionId 索引的
 * registry 里（宿主级单实例注入，与它取代的 `ContextAttentionSessionRegistry` 同一注入位）。
 *
 * ## 摄入的唯一难点：历史会被上游改写
 * `sanitizeHistoryForProvider` / 结构自愈每轮都可能重建消息对象，所以"上次摄入过的消息"不能靠
 * 对象身份认。这里按**逐条内容指纹的前缀比对**认：
 *  - 前缀一致 → 只追加新出的尾巴（增量 append，缓存安全）；
 *  - 前缀分叉（历史被截断 / 编辑 / 回滚 / 换会话）→ 整本重建。
 * 重建是正确性兜底，不是常态：分叉意味着上游已经换了一份历史，继续增量只会把两份历史缝起来。
 *
 * ## 治理不发生时必须逐字等价
 * `syncHistory` 之后若未触发 epoch，全部记录都是准入态，投影输出与输入消息**同一批对象、同一
 * 顺序**（B0 已钉"摄入→投影==原历史"）。切换编译器的行为对齐就压在这条上。
 */
import type { ModelMessage } from 'ai'

import { isEmpty, isNotNull, isNull, isPresent, toNullable } from '@velaros-ai/core'

import type { ContextRecordClassifier } from './admission'
import type { ContextRecord } from './ContextRecord'
import { stableFingerprint } from './determinism'
import { type ContextDistiller, planContextDistillation } from './distill'
import { ContextDistillRunner } from './distillRunner'
import {
  type ContextGovernanceConfig,
  type ContextGovernanceConfigInput,
  resolveContextGovernanceConfig,
} from './governanceConfig'
import {
  type GovernanceEpochReport,
  type GovernanceEpochSource,
  measureProjectedTokens,
  resolveProjectionBudget,
  runGovernanceEpoch,
  shouldOpenGovernanceEpoch,
} from './GovernanceEpoch'
import {
  type GovernanceWindowDerivation,
  type GovernanceWindowInput,
  resolveGovernanceWindow,
} from './governanceWindow'
import { planHistoryIngest } from './ingest'
import type { ContextMigrationEventSink } from './migrationLog'
import { measureLedgerProjection } from './projection'
import { ContextResidencyLedger } from './ResidencyLedger'

/** 模型声明阶段边界的工具名（语义升格为"请求开一次 epoch"，见设计 §5.2）。 */
export const ContextEpochRequestToolName = 'context:distill'

/** 每会话保留的 epoch 报告条数（转交信号只看最近若干次，无限留等于内存泄漏）。 */
const MaxRetainedEpochReports = 32
const DefaultMaxTrackedSessions = 128

/** 转交信号（设计 §4）：连续 2 次 epoch 节省率不足且 post-epoch 占用仍高 → 建议开新会话。 */
export interface ContextHandoffSignal {
  /** 是否建议布防 handoff 卡。 */
  armed: boolean
  /** 最近若干次 epoch 的节省率序列（新→旧）。 */
  recentSavingPercents: number[]
  /** 最近一次 epoch 之后的预算占用百分比；从未跑过 epoch 时为 null。 */
  lastEpochAfterPercent: Nullable<number>
  reason: Nullable<'low-saving-streak'>
}

/**
 * 消息 → 指纹的对象身份缓存。
 *
 * `syncHistory` 每轮要对**整条历史**逐条 `stableFingerprint`（键排序递归序列化），而 99% 的轮次
 * 结论都是"前缀完全一致，只追加了尾巴"。清洗链在稳态下保持对象身份（每层都 `changed ? next :
 * original`），所以已摄入那截绝大多数轮次是同一批引用——按身份缓存即可把每轮成本从 O(整条历史
 * 字节数) 降到 O(新增尾巴)。WeakMap：消息被丢弃时条目自动回收，缓存不构成泄漏。
 *
 * 前提（也是全链既有纪律）：**没有人原地改写已经进过历史的消息对象**——要改就产生新对象。原地
 * 改会让缓存给出陈旧指纹，前缀比对把已经变了的那截当成没变。
 */
const fingerprintByMessage = new WeakMap<ModelMessage, string>()

function cachedStableFingerprint(message: ModelMessage): string {
  const cached = fingerprintByMessage.get(message)
  if (isPresent(cached)) return cached

  const fingerprint = stableFingerprint(message)
  fingerprintByMessage.set(message, fingerprint)
  return fingerprint
}

export interface ContextGovernanceSyncInput {
  messages: readonly ModelMessage[]
  at: number
  /**
   * 全保真层引用：toolCallId → payloadRef（PayloadStore 已存的原文）。
   * 准入期把它落进记录，EXCERPT / 墓碑信封的召回引用才能用内容寻址的 payloadRef
   * 而不是只能退回 toolCallId。
   */
  payloadRefsByToolCallId?: LooseOptional<Readonly<Record<string, string>>>
  /** 超长 user 正文的内容哈希 → 持久 payloadRef。 */
  userTextPayloadRefsByHash?: LooseOptional<Readonly<Record<string, string>>>
  /**
   * 本轮编译期实测的字符/token 密度。
   *
   * 摄入期就要拿到它：准入事件的 `tokensDelta` 是账本自己出的账，它按 4 记而治理器按实测记，
   * 同一本账本就有了两个数（§16.5 挂账「stats() 密度」的同一根）。
   */
  charsPerToken?: LooseOptional<number>
}

export interface ContextGovernanceSyncResult {
  /** 本次同步是否整本重建了账本（历史前缀分叉）。 */
  rebuilt: boolean
  appendedCount: number
}

export interface ContextGovernanceSessionOptions {
  /**
   * I2 蒸馏器解析器（晚绑）。
   *
   * 传的是**解析函数**而不是实例：registry 是宿主级单实例，在装配 Phase 0 就造出来，而模型运行时
   * 要到执行栈那一步才有。传实例意味着"注册表建好那一刻蒸馏器必须已经存在"，那就把装配顺序钉死了。
   */
  resolveDistiller?: LooseOptional<() => Nullable<ContextDistiller>>
  sessionId?: LooseOptional<string>
}

/** 单会话治理状态。 */
export class ContextGovernanceSession {
  public readonly config: ContextGovernanceConfig
  private ledgerRef: ContextResidencyLedger
  private ingestedFingerprints: string[] = []
  private nextTurn = 0
  /** 跨批的轮边界状态：增量摄入与整批摄入必须对同一份历史给出同一套轮序（审计 V8/U22）。 */
  private turnBoundarySeen = false
  private epochSeq = 0
  /**
   * 账本代数：每整本重建一次 +1。
   *
   * 蒸馏产物带着规划时的代数出门，落地前逐条核对——记录 id 是按序号发的，重建后同一个
   * `ctx-r000003` 已经是另一条消息，没有这个护栏就会把上一段历史的摘要贴到这一段上。
   */
  private ledgerGeneration = 0
  private readonly reports: GovernanceEpochReport[] = []
  /**
   * 已消费过的 `context:distill` 请求身份 —— 存 **toolCallId 而不是记录 id**。
   *
   * 记录 id 是按序号发的，账本一重建就重新发一遍，同一条请求换了名字、旧游标当场失效；反过来
   * 一条早就消费过的请求被重摄入回来，又会被当成新的再触发一次 epoch。toolCallId 由 provider
   * 发号、跨重建逐字稳定，两种情况在结构上就分开了：旧请求天然不触发、新请求天然触发，
   * `resetLedger` 因此不清它，`syncHistory` 也不需要"重建后对齐游标"那条特判（审计 R3/U19）。
   */
  private lastConsumedEpochRequestToolCallId: Nullable<string> = null
  private readonly distillRunner: ContextDistillRunner
  public updatedAt = 0
  /**
   * 最近一次编译期治理用的量纲（送核门窗口口径 + 字符/token 密度）。
   *
   * 手动 epoch（宿主 `compact_session`、缺页降级阶梯）拿不到编译期算出来的密度，也未必拿得到
   * 模型窗口与固定开销；缺席时回落写死的 4 字符/token + cap，会让同一本账本的手动报告与自动
   * 报告不同量纲——中文/JSON 密集会话实测密度约 1.5-2，占用因此被低估 2-3 倍，手动 epoch 当场
   * 空转，而这两类报告又混在同一个 `reports[]` 里喂 handoff 判据（审计 V9 / U11）。
   * 记住最近一次编译的量纲当回落，比让调用方各自去凑要可靠。
   *
   * 窗口侧记的是**推导入参**而不是算好的 G：手动路径可以只补一个自己知道的字段（比如模型窗口），
   * 其余仍走上一次编译的实测值，最终仍由 `resolveGovernanceWindow` 这一个口算出 G。
   */
  private lastCompiledCharsPerToken: Nullable<number> = null
  private lastCompiledWindowInput: GovernanceWindowInput = {}
  /** 最近一次解析出来的治理窗口（编译器与 dashboard 共用，杜绝抄一份公式）。 */
  private lastWindow: Nullable<GovernanceWindowDerivation> = null

  public constructor(
    config: ContextGovernanceConfig,
    private readonly classifier: Nullable<ContextRecordClassifier>,
    private readonly sink: Nullable<ContextMigrationEventSink>,
    options: ContextGovernanceSessionOptions = {}
  ) {
    this.config = config
    this.ledgerRef = this.createLedger()
    this.distillRunner = new ContextDistillRunner({
      resolveDistiller: options.resolveDistiller ?? ((): Nullable<ContextDistiller> => null),
      sessionId: options.sessionId?.trim() || null,
    })
  }

  public get ledger(): ContextResidencyLedger {
    return this.ledgerRef
  }

  public get epoch(): number {
    return this.epochSeq
  }

  /** 账本代数（每整本重建一次 +1）：诊断面与断言电池据此判断"这本账本被重建过没有"。 */
  public get generation(): number {
    return this.ledgerGeneration
  }

  public epochReports(): readonly GovernanceEpochReport[] {
    return this.reports
  }

  /** 把本轮的 provider 历史同步进账本：前缀一致则增量追加，分叉则整本重建。 */
  public syncHistory(input: ContextGovernanceSyncInput): ContextGovernanceSyncResult {
    const { messages, at } = input
    // 量纲先落地再摄入：重建出来的新账本要带着同一把尺子出生。
    this.applyMeasuredCharsPerToken(input.charsPerToken)
    const fingerprints = messages.map((message) => cachedStableFingerprint(message))
    const sharedPrefix = resolveSharedPrefixLength(this.ingestedFingerprints, fingerprints)
    const rebuilt = sharedPrefix < this.ingestedFingerprints.length
    if (rebuilt) this.resetLedger()

    const from = rebuilt ? 0 : sharedPrefix
    const tail = messages.slice(from)
    if (!isEmpty(tail)) {
      const plan = planHistoryIngest(tail, {
        baseCreatedAt: at,
        startTurn: this.nextTurn,
        turnBoundarySeen: this.turnBoundarySeen,
        payloadRefsByToolCallId: input.payloadRefsByToolCallId,
        userTextPayloadRefsByHash: input.userTextPayloadRefsByHash,
      })
      for (const admission of plan.inputs) this.ledgerRef.append(admission)
      this.nextTurn = plan.nextTurn
      this.turnBoundarySeen = plan.turnBoundarySeen
    }
    this.ingestedFingerprints = fingerprints
    this.updatedAt = at
    return { rebuilt, appendedCount: tail.length }
  }

  /** 当前投影占用（token），与投影共用尾保护规则。 */
  public projectedTokens(
    budgetTokens: number,
    charsPerToken?: LooseOptional<number>
  ): number {
    return measureProjectedTokens(
      this.ledgerRef,
      this.config,
      budgetTokens,
      charsPerToken
    )
  }

  /**
   * 当前治理窗口 G 的完整推导（编译器组装投影预算 / dashboard 用同一份，不许各算各的）。
   *
   * 还没编译过时按已记住的入参现算一遍：默认入参下它退化成"只受送核门红线与 cap 约束"。
   */
  public governanceWindow(): GovernanceWindowDerivation {
    return this.lastWindow ?? resolveGovernanceWindow(this.config, this.lastCompiledWindowInput)
  }

  /**
   * 轮边界治理：按需跑一次 epoch。
   *
   * G 由 `resolveGovernanceWindow` 从**送核门同一口径**导出（模型窗口 + 输出预留 + 安全余量 +
   * 固定开销），不再是 `min(模型窗口, cap)`。返回 null 表示本轮既未触发也未跳过记账（账本为空）。
   */
  public governTurn(
    input: GovernanceWindowInput & {
      at: number
      charsPerToken?: LooseOptional<number>
    }
  ): Nullable<GovernanceEpochReport> {
    // 编译期是唯一算得出真实量纲的地方，记下来给手动 epoch 当回落。
    this.applyMeasuredCharsPerToken(input.charsPerToken)
    this.lastCompiledWindowInput = {
      modelWindowTokens: input.modelWindowTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      safetyMarginPercent: input.safetyMarginPercent,
      fixedOverheadTokens: input.fixedOverheadTokens,
    }

    const modelRequested = this.consumeModelEpochRequest()
    return this.runEpoch(input, modelRequested, modelRequested ? 'model-tool' : 'watermark')
  }

  /**
   * 手动开一次 epoch（宿主的 `compact_session` 落点）。
   *
   * 语义与模型调 `context:distill` 完全一致——**请求开一次 epoch**，绕过水位触发线，但反空转、
   * 尾保护、达标即停等器械纪律一条不减。手动不等于强拆：压不下去的出路仍是转交，不是压尾。
   *
   * 量纲缺席时回落**最近一次编译**的窗口口径与密度，而不是回落写死的 cap 与 4 字符/token：
   * 手动路径与自动路径必须在同一把尺子上，否则两类报告混进同一个 `reports[]` 会把 handoff
   * 判据带偏。固定开销同理——手动 epoch 不知道本轮工具清单有多大，用上一次编译实测的就是了。
   */
  public requestEpoch(
    input: GovernanceWindowInput & {
      at: number
      charsPerToken?: LooseOptional<number>
      source?: LooseOptional<GovernanceEpochSource>
    }
  ): Nullable<GovernanceEpochReport> {
    const fallback = this.lastCompiledWindowInput
    return this.runEpoch(
      {
        at: input.at,
        modelWindowTokens: input.modelWindowTokens ?? fallback.modelWindowTokens,
        reservedOutputTokens: input.reservedOutputTokens ?? fallback.reservedOutputTokens,
        safetyMarginPercent: input.safetyMarginPercent ?? fallback.safetyMarginPercent,
        fixedOverheadTokens: input.fixedOverheadTokens ?? fallback.fixedOverheadTokens,
        charsPerToken: input.charsPerToken ?? this.lastCompiledCharsPerToken,
      },
      true,
      input.source ?? 'host-request'
    )
  }

  private runEpoch(
    input: GovernanceWindowInput & {
      at: number
      charsPerToken?: LooseOptional<number>
    },
    modelRequested: boolean,
    source: GovernanceEpochSource
  ): Nullable<GovernanceEpochReport> {
    const window = resolveGovernanceWindow(this.config, input)
    this.lastWindow = window
    // 记账口径随会话走：dashboard / stats() 与 epoch 报告必须是同一把尺子（§16.5 挂账）。
    this.applyMeasuredCharsPerToken(input.charsPerToken)
    if (isEmpty(this.ledgerRef.list())) return null

    const budgetTokens = window.windowTokens
    const startedAt = Date.now()
    const epoch = this.epochSeq + 1
    // 只在 epoch 真的会开时才把待落地产物交出去：epoch 拿到就会消费，而它若以 below-trigger
    // 当场返回，这批已经付过钱的产物就白丢了。
    const willOpen = shouldOpenGovernanceEpoch({
      ledger: this.ledgerRef,
      config: this.config,
      budgetTokens,
      modelRequested,
      charsPerToken: input.charsPerToken,
    })
    const raw = runGovernanceEpoch({
      ledger: this.ledgerRef,
      config: this.config,
      budgetTokens,
      window,
      epoch,
      at: input.at,
      modelRequested,
      source,
      charsPerToken: input.charsPerToken,
      pendingDistills: willOpen ? this.distillRunner.takePending(this.ledgerGeneration) : [],
      ledgerGeneration: this.ledgerGeneration,
    })
    // 耗时在**跑完之后**测量并回填：epoch 是纯函数（不取时钟），时钟只归调用方。
    const report: GovernanceEpochReport = {
      ...raw,
      distill: {
        ...raw.distill,
        ...this.scheduleDistillation(
          raw,
          budgetTokens,
          epoch,
          input.charsPerToken
        ),
      },
      durationMs: Math.max(0, Date.now() - startedAt),
    }
    // 只有真正应用了迁移才推进 epoch 号：跳过的 epoch 不是一代，dashboard 上的号必须与
    // "缓存被重建过几次"一一对应，否则模型看到号在涨却没有任何东西变短。
    if (report.applied) this.epochSeq += 1
    this.pushReport(report)
    return report
  }

  /**
   * 规划下一次蒸馏（**不 await**：回合永远不等模型）。
   *
   * 规划在 epoch **之后**：判据里的"机械器械跑完仍差多少"要拿 I0/I1 之后的实际占用去算，
   * 在 epoch 之前问等于拿旧数问新账。产物落到下一个边界，是 P4「每 epoch 恰好一次缓存重建」
   * 的直接后果，也是调研里 sleep-time compute 的形态。
   */
  private scheduleDistillation(
    report: GovernanceEpochReport,
    budgetTokens: number,
    epoch: number,
    charsPerToken?: LooseOptional<number>
  ): Pick<GovernanceEpochReport['distill'], 'planned' | 'skipReason' | 'gate' | 'totals'> {
    // 未触发的 epoch 不规划：没跑器械就没有"机械没达标"这回事。
    if (isNull(report.trigger))
      return { planned: false, skipReason: null, gate: null, totals: this.distillRunner.totals() }

    const measurement = measureLedgerProjection({
      records: this.ledgerRef.list(),
      residency: this.ledgerRef.residencyVector(),
      budget: resolveProjectionBudget(this.config, budgetTokens, charsPerToken),
    })
    const plan = planContextDistillation({
      ledger: this.ledgerRef,
      config: this.config,
      budgetTokens,
      projectedTokens: measurement.projectedTokens,
      tailProtectedRecordIds: measurement.tailProtectedRecordIds,
      epoch,
      generation: this.ledgerGeneration,
      hasDistiller: this.distillRunner.hasDistiller(),
      busy: this.distillRunner.busy,
      pendingCount: this.distillRunner.pendingCount,
      maxPendingProducts: this.distillRunner.maxPendingProducts,
    })
    this.distillRunner.schedule(plan.requests, this.config)

    return {
      planned: !isEmpty(plan.requests),
      skipReason: plan.skipReason,
      gate: plan.gate,
      totals: this.distillRunner.totals(),
    }
  }

  /**
   * 等在飞的蒸馏落地（测试与 headless 实验用）。
   *
   * 产品路径**永不** await 它——那就退回 v1 的内联阻塞了。它存在只是为了让断言电池不必靠
   * sleep 猜时序。
   */
  public whenDistillSettled(): Promise<void> {
    return this.distillRunner.settled()
  }

  /**
   * 缺页记账：`context:recall` 命中账本记录时调用。
   *
   * `ref` 可以是记录 id、payloadRef 或 toolCallId —— 折叠信封给模型的指引就是这三种之一，
   * 这里全认，命中不了直接返回 false（其它折叠机制的引用不该记进本账本的 fault 率）。
   */
  public recordFault(ref: string, at: number): boolean {
    const record = this.findRecordByRef(ref)
    if (!record) return false
    // 缺页的字面意思：**这一页当时不在**。召回一条仍然 INLINE 的记录不是治理失误，
    // 记进 fault 率只会让"降级降错了"的信号被日常召回稀释掉。
    if (this.ledgerRef.residencyOf(record.id) === 'INLINE') return false

    this.ledgerRef.recordFault(record.id, at)
    return true
  }

  /**
   * 转交信号：连续 N 次低收益 epoch 且 post-epoch 占用仍高。
   *
   * **只看当前代账本的报告**：账本一重建（用户回滚/编辑历史、切会话、结构自愈）就换代，上一代那
   * 两条"压不下去"的报告说的是另一段对话；`resetLedger` 不清 `reports`，不按代过滤就会在一段刚被
   * 截短、占用极低的对话上继续弹"建议开新会话"（审计 U34 / U16）。
   */
  public handoffSignal(): ContextHandoffSignal {
    const streak = this.config.handoff.lowSavingStreak
    const applied = this.reports
      .filter(
        (report) =>
          isNotNull(report.trigger) && report.ledgerGeneration === this.ledgerGeneration
      )
      .slice(-streak)
    const recentSavingPercents = [...applied].reverse().map((report) => report.savingPercent)
    const last = applied.at(-1)
    const lastEpochAfterPercent = toNullable(last?.afterPercent)
    const lowSavingStreak =
      applied.length >= streak &&
      applied.every((report) => report.savingPercent < this.config.minEpochSavingPercent)
    const armed =
      lowSavingStreak &&
      isNotNull(lastEpochAfterPercent) &&
      lastEpochAfterPercent > this.config.handoff.occupancyPercent

    return {
      armed,
      recentSavingPercents,
      lastEpochAfterPercent,
      reason: armed ? 'low-saving-streak' : null,
    }
  }

  /**
   * 模型是否在**最新一轮**调用了 `context:distill`（= 请求开一次 epoch）。
   *
   * 信号从账本结构里读，不从工具 handler 推 —— handler 侧信号需要一条穿过 ToolContext 的
   * 新端口，而这个事实本来就在历史里逐字可查；从账本读还天然可离线重放（B4 的前提）。
   * 每条请求**按 toolCallId 只消费一次**，避免同一次调用在后续轮次反复触发 epoch；账本重建把
   * 旧请求原样带回来时，toolCallId 与游标相同，天然不再触发（审计 R3/U19）。
   */
  private consumeModelEpochRequest(): boolean {
    const latest = this.findLatestEpochRequestToolCallId()
    if (isNull(latest) || latest === this.lastConsumedEpochRequestToolCallId) return false

    this.lastConsumedEpochRequestToolCallId = latest
    return true
  }

  /**
   * 账本里最后一条 `context:distill` 结果记录的 toolCallId（没有则 null）。
   *
   * 结构异常导致读不到 toolCallId 时回落记录 id：那条回落路径跨代不稳定，但"这一轮有没有请求"
   * 仍然答得出，比整条信号消失好。
   */
  private findLatestEpochRequestToolCallId(): Nullable<string> {
    const records = this.ledgerRef.list()
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record.kind === 'tool-result' && record.toolName === ContextEpochRequestToolName)
        return record.toolCallId ?? record.id
    }

    return null
  }

  private findRecordByRef(ref: string): Nullable<ContextRecord> {
    const key = ref.trim()
    if (!key) return null

    const direct = this.ledgerRef.get(key)
    if (direct) return direct

    // 折叠信封的 ref 优先用 payloadRef，其次 toolCallId；`tool:<id>` 是 v1 沿用的前缀形态。
    const bare = key.startsWith('tool:') ? key.slice('tool:'.length) : key
    for (const record of this.ledgerRef.list()) {
      if (record.payloadRef === key || record.toolCallId === bare) return record
      if (record.excerpt?.ref === key) return record
    }

    return null
  }

  /** 记住实测量纲并推给当前账本；缺席不覆盖（见 `ContextResidencyLedger.setCharsPerToken`）。 */
  private applyMeasuredCharsPerToken(value: LooseOptional<number>): void {
    if (!isPresent(value)) return

    this.lastCompiledCharsPerToken = value
    this.ledgerRef.setCharsPerToken(value)
  }

  private pushReport(report: GovernanceEpochReport): void {
    this.reports.push(report)
    if (this.reports.length > MaxRetainedEpochReports) {
      this.reports.splice(0, this.reports.length - MaxRetainedEpochReports)
    }
  }

  private resetLedger(): void {
    // 代数 +1 **先于**建账本：新账本要把新代数盖进自己发出的每一条事件里
    // （事件流按 id 重放，跨代同名 id 必须能分开——审计 desktop-wiring 优化 6）。
    this.ledgerGeneration += 1
    this.ledgerRef = this.createLedger()
    this.ingestedFingerprints = []
    this.nextTurn = 0
    this.turnBoundarySeen = false
    // `lastConsumedEpochRequestToolCallId` **刻意不清**：它认的是 provider 发的调用号，跨代稳定。
    // 清了就等于"重摄入回来的旧请求再触发一次 epoch"，那正是 U19 的形态。
    // 清空在途蒸馏：新一代的 id 与旧产物指向的完全不是同一批记录。
    this.distillRunner.reset()
  }

  private createLedger(): ContextResidencyLedger {
    return new ContextResidencyLedger({
      config: this.config,
      classifier: this.classifier,
      sink: this.sink,
      ledgerGeneration: this.ledgerGeneration,
      // 量纲跨代携带：密度是**尺子**不是账本内容，换一本账本不该换一把尺子。
      charsPerToken: this.lastCompiledCharsPerToken,
    })
  }
}

export interface ContextGovernanceSessionRegistryOptions {
  /** 宿主注入的治理配置（宽容解析 + 默认值兜底）。 */
  config?: LooseOptional<ContextGovernanceConfigInput>
  /** 领域语义分类器：refetchable / 去重目标 / pinned（能力包注入，agent 包不认工具名单）。 */
  classifier?: LooseOptional<ContextRecordClassifier>
  /** 迁移事件汇工厂；缺省关闭落盘（agent 包 host 无关，写盘是宿主的事）。 */
  sinkFactory?: LooseOptional<(sessionId: string) => Nullable<ContextMigrationEventSink>>
  /** 最大跟踪会话数；超出按"最近使用"淘汰最旧的那个。 */
  maxTrackedSessions?: LooseOptional<number>
  /**
   * I2 蒸馏器（宿主注入的一次辅助模型调用）。缺省 = 治理退化为纯机械：
   * 档位仍按配置记账，但每次规划都以 `no-distiller` 跳过，不会静默假装蒸馏过。
   */
  distiller?: LooseOptional<ContextDistiller>
}

/**
 * 治理会话登记处（宿主级单实例）。
 *
 * 取代 `ContextAttentionSessionRegistry` 的注入位：编译器、召回服务与转交信号消费同一份状态。
 */
export class ContextGovernanceSessionRegistry {
  private readonly sessions = new Map<string, ContextGovernanceSession>()
  private config: ContextGovernanceConfig
  private readonly classifier: Nullable<ContextRecordClassifier>
  private readonly sinkFactory: Nullable<(sessionId: string) => Nullable<ContextMigrationEventSink>>
  private readonly maxTrackedSessions: number
  private distiller: Nullable<ContextDistiller>

  public constructor(options: ContextGovernanceSessionRegistryOptions = {}) {
    this.config = resolveContextGovernanceConfig(options.config)
    this.classifier = toNullable(options.classifier)
    this.sinkFactory = toNullable(options.sinkFactory)
    this.maxTrackedSessions = options.maxTrackedSessions ?? DefaultMaxTrackedSessions
    this.distiller = toNullable(options.distiller)
  }

  public governanceConfig(): ContextGovernanceConfig {
    return this.config
  }

  /**
   * 晚绑 I2 蒸馏器。
   *
   * 与 `configure` 的"只影响新会话"相反，蒸馏器**立刻对全部会话生效**：它不是策略参数而是能力
   * 供给，换它不改变任何阈值，也就不会让同一本账本前后半段按两套规则治理。会话持有的是解析
   * 函数（`() => this.distiller`），所以晚到的注入能穿到已存在的会话。
   */
  public setDistiller(distiller: LooseOptional<ContextDistiller>): void {
    this.distiller = toNullable(distiller)
  }

  /**
   * 晚绑治理配置（宿主的 `AgentSystemRuntimeConfig.contextGovernance` 在 run 开始时推进来）。
   *
   * registry 是宿主级单实例、比任何一次 run 都长寿，所以配置只能后到。**已存在的会话不改配置**：
   * 半程换水位会让同一本账本的前后半段按两套规则治理，epoch 报告与离线重放当场失去可比性；
   * 新配置从下一个新会话起生效，想立刻生效就 `invalidateSession`。
   */
  public configure(input: LooseOptional<ContextGovernanceConfigInput>): ContextGovernanceConfig {
    this.config = resolveContextGovernanceConfig(input)
    return this.config
  }

  /** 解析（并按需创建）会话治理器；sessionId 为空时返回 null（无身份不建状态）。 */
  public resolve(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSession> {
    const key = sessionId?.trim()
    if (!key) return null

    const existing = this.sessions.get(key)
    if (existing) {
      // 命中即"最近使用"：删了再塞把它挪到 Map 尾部（Map 保插入序 = 这里的 LRU 序）。
      this.sessions.delete(key)
      this.sessions.set(key, existing)
      return existing
    }

    const created = new ContextGovernanceSession(
      this.config,
      this.classifier,
      toNullable(this.sinkFactory?.(key)),
      { resolveDistiller: () => this.distiller, sessionId: key }
    )
    this.sessions.set(key, created)
    this.evictOldestSessionsBeyondLimit()
    return created
  }

  /** 已存在才返回，不建新会话（只读查询用）。 */
  public peek(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSession> {
    const key = sessionId?.trim()
    if (!key) return null

    return toNullable(this.sessions.get(key))
  }

  /** fault 记账入口：`context:recall` 每次取回后调用；未命中账本返回 false。 */
  public recordFault(sessionId: LooseOptional<string>, ref: string, at: number = Date.now()): boolean {
    return !!this.peek(sessionId)?.recordFault(ref, at)
  }

  /** 转交信号（B1b 的 handoff 布防数据源）。 */
  public handoffSignal(sessionId: LooseOptional<string>): Nullable<ContextHandoffSignal> {
    return toNullable(this.peek(sessionId)?.handoffSignal())
  }

  /**
   * 手动开一次 epoch（宿主 hook 的落点）。用 `peek` 而不是 `resolve`：从没编译过的会话没有账本，
   * 为了"压一下"凭空建一本空账本只会产出一份没有信息的报告。
   */
  public requestEpoch(
    sessionId: LooseOptional<string>,
    input: {
      at?: LooseOptional<number>
      modelWindowTokens?: LooseOptional<number>
      /** 字符/token 密度；缺席时会话回落到最近一次编译期实测的量纲。 */
      charsPerToken?: LooseOptional<number>
      source?: LooseOptional<GovernanceEpochSource>
    } = {}
  ): Nullable<GovernanceEpochReport> {
    return toNullable(
      this.peek(sessionId)?.requestEpoch({
        at: input.at ?? Date.now(),
        modelWindowTokens: input.modelWindowTokens,
        charsPerToken: input.charsPerToken,
        source: input.source,
      })
    )
  }

  /** 最近若干次 epoch 报告（scoreboard / 调试面数据源）。 */
  public epochReports(sessionId: LooseOptional<string>): readonly GovernanceEpochReport[] {
    return this.peek(sessionId)?.epochReports() ?? []
  }

  /** 硬失效通道：会话重置 / handoff / 清空时丢弃全部治理状态。 */
  public invalidateSession(sessionId: LooseOptional<string>): void {
    const key = sessionId?.trim()
    if (key) this.sessions.delete(key)
  }

  /**
   * 容量淘汰：按 Map 插入序（= LRU 序，`resolve` 命中时会把条目挪到尾部）从头删。
   *
   * 原实现按 `updatedAt` 升序删，而新建会话的 `updatedAt` 是 0（只有 `syncHistory` 才赋值），
   * 于是满员之后**每次都把刚建的那个当场删掉**：它这一轮还能用（`resolve` 返回的是对象本身），
   * 下一轮 peek 不到又重建一个，账本每轮从零开始，老的 128 个反而永远淘汰不掉（审计 V7）。
   * 换成插入序就不需要任何时钟：刚建的条目恒在尾部，结构上不可能被本次淘汰选中。
   */
  private evictOldestSessionsBeyondLimit(): void {
    if (this.sessions.size <= this.maxTrackedSessions) return

    const overflow = this.sessions.size - this.maxTrackedSessions
    const oldestFirst = [...this.sessions.keys()].slice(0, overflow)
    for (const sessionId of oldestFirst) this.sessions.delete(sessionId)
  }
}

/** 两串指纹的公共前缀长度。 */
function resolveSharedPrefixLength(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}
