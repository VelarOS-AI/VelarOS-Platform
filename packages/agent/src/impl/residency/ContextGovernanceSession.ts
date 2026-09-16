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

import type { ContextMigrationEventSink } from '../../contract/requires.js'
import type { ContextDistiller, ContextGovernanceConfig, ContextGovernanceSessionApi as ContextGovernanceSessionContract, ContextGovernanceSyncInput, ContextGovernanceSyncResult, ContextHandoffSignal, ContextRecord, ContextRecordClassifier, GovernanceEpochReport, GovernanceEpochSource, GovernanceWindowDerivation, GovernanceWindowInput } from '../../types/residency.js'
import { resolveSharedPrefixLength } from '../../utils/residency/context-governance-session'
import { stableFingerprint } from '../../utils/residency/determinism'
import { planContextDistillation } from '../../utils/residency/distill'
import { measureProjectedTokens, resolveProjectionBudget, runGovernanceEpoch, shouldOpenGovernanceEpoch } from '../../utils/residency/governance-epoch'
import { resolveGovernanceWindow } from '../../utils/residency/governance-window'
import { planHistoryIngest } from '../../utils/residency/ingest'
import { measureLedgerProjection } from '../../utils/residency/projection'
import { AgentTuning } from '../../utils/tuning'

import { ContextDistillRunner } from './ContextDistillRunner'
import { ContextResidencyLedger } from './ContextResidencyLedger'

/** 建 `ContextGovernanceSession` 时可选的两项（配置、分类器、事件汇走构造函数的前三个位置参数，不在这里）。 */
export interface ContextGovernanceSessionOptions {
  /**
   * I2 蒸馏器解析器（晚绑）。
   *
   * 传的是**解析函数**而不是实例：registry 是宿主级单实例，在装配 Phase 0 就造出来，而模型运行时
   * 要到执行栈那一步才有。传实例意味着"注册表建好那一刻蒸馏器必须已经存在"，那就把装配顺序钉死了。
   */
  resolveDistiller?: LooseOptional<() => Nullable<ContextDistiller>>
  /** 这个治理会话对应哪条会话；只往下传给蒸馏端口当遥测上下文，治理本身不用它做索引（登记表在外面按 id 存）。空白串按缺席处理。 */
  sessionId?: LooseOptional<string>
}

/**
 * 单个会话的上下文治理面：把本轮历史同步进账本、算治理窗口 G、到点跑一次 epoch 把该降的降下去、记缺页、给转交信号。
 *
 * 实现是 `ContextGovernanceSession`，登记处按会话 id 各持一个；账本、轮序、epoch 报告和在飞的蒸馏全在这个实例里，只在内存。
 * 形状与对外公开的 `ContextGovernanceSessionApi` 同源，这里把它挪到类上方当本类的接口。
 */
export interface ContextGovernanceSessionApi extends ContextGovernanceSessionContract {}

/** 单会话治理状态。 */
export class ContextGovernanceSession implements ContextGovernanceSessionApi {
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
  private readonly distillRunner: ContextDistillRunner
  public updatedAt = 0

  /**
   * 消息 → 指纹的对象身份缓存（本会话内）。
   *
   * `syncHistory` 每轮要对**整条历史**逐条 `stableFingerprint`（键排序递归序列化），而 99% 的轮次
   * 结论都是"前缀完全一致，只追加了尾巴"。清洗链在稳态下保持对象身份（每层都 `changed ? next :
   * original`），所以已摄入那截绝大多数轮次是同一批引用——按身份缓存即可把每轮成本从 O(整条历史
   * 字节数) 降到 O(新增尾巴)。WeakMap：消息被丢弃时条目自动回收，缓存不构成泄漏。
   *
   * 前提（也是全链既有纪律）：**没有人原地改写已经进过历史的消息对象**——要改就产生新对象。原地
   * 改会让缓存给出陈旧指纹，前缀比对把已经变了的那截当成没变。
   */
  private readonly fingerprintByMessage = new WeakMap<ModelMessage, string>()
  /**
   * 最近一次编译期治理用的量纲（送核门窗口口径 + 字符/token 密度）。
   *
   * 供应方溢出的内部恢复拿不到编译期算出来的密度，也未必拿得到
   * 模型窗口与固定开销；缺席时回落写死的 4 字符/token + cap，会让同一本账本的恢复报告与容量治理
   * 报告不同量纲——中文/JSON 密集会话实测密度约 1.5-2，占用因此被低估 2-3 倍，恢复当场
   * 空转，而这两类报告又混在同一个 `reports[]` 里喂 handoff 判据（审计 V9 / U11）。
   * 记住最近一次编译的量纲当回落，比让调用方各自去凑要可靠。
   *
   * 窗口侧记的是**推导入参**而不是算好的 G：内部恢复路径可以只补一个自己知道的字段（比如模型窗口），
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
  /** 按消息身份取指纹，未命中时现算并记账。 */
  private cachedStableFingerprint(message: ModelMessage): string {
    const cached = this.fingerprintByMessage.get(message)
    if (isPresent(cached)) return cached

    const fingerprint = stableFingerprint(message)
    this.fingerprintByMessage.set(message, fingerprint)
    return fingerprint
  }

  public syncHistory(input: ContextGovernanceSyncInput): ContextGovernanceSyncResult {
    const { messages, at } = input
    // 量纲先落地再摄入：重建出来的新账本要带着同一把尺子出生。
    this.applyMeasuredCharsPerToken(input.charsPerToken)
    const fingerprints = messages.map((message) => this.cachedStableFingerprint(message))
    const sharedPrefix = resolveSharedPrefixLength(this.ingestedFingerprints, fingerprints)
    const rebuilt = sharedPrefix < this.ingestedFingerprints.length
    const from = rebuilt ? 0 : sharedPrefix
    const tail = messages.slice(from)
    if (rebuilt) this.resetLedger()

    if (!isEmpty(tail)) {
      const plan = planHistoryIngest(tail, {
        baseCreatedAt: at,
        startTurn: this.nextTurn,
        turnBoundarySeen: this.turnBoundarySeen,
        payloadRefsByToolCallId: input.payloadRefsByToolCallId,
        userTextPayloadRefsByHash: input.userTextPayloadRefsByHash,
      })
      for (const admission of plan.inputs) this.ledgerRef.append({ ...admission, deferOversizeExcerpt: input.deferOversizeExcerpt })
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
      /** 编译器按完整请求实测的容量结论；false 时即使旧配置水位较低也不回收。 */
      capacityExceeded?: LooseOptional<boolean>
    }
  ): Nullable<GovernanceEpochReport> {
    // 编译期是唯一算得出真实量纲的地方，记下来给溢出恢复当回落。
    this.applyMeasuredCharsPerToken(input.charsPerToken)
    this.lastCompiledWindowInput = {
      modelWindowTokens: input.modelWindowTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      safetyMarginPercent: input.safetyMarginPercent,
      fixedOverheadTokens: input.fixedOverheadTokens,
    }

    // 历史里的模型治理请求不再构成主动入口；自动治理只认本轮完整输入容量。
    const window = resolveGovernanceWindow(this.config, input)
    const capacityExceeded = input.capacityExceeded ?? (
      this.projectedTokens(window.windowTokens, input.charsPerToken) > window.windowTokens
    )
    return this.runEpoch({ ...input, capacityExceeded }, false, 'capacity')
  }

  /**
   * 内部强制治理入口，供供应方 context overflow 后的自动恢复使用。
   * 请求复用最近一次编译的窗口、输出预留、固定开销和密度；仍保留原文、配对结构与净收益约束。
   * 方法名和来源参数兼容旧宿主 API，不会从模型消息中自动触发。
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
      input.source ?? 'overflow-recovery'
    )
  }

  private runEpoch(
    input: GovernanceWindowInput & {
      at: number
      charsPerToken?: LooseOptional<number>
      capacityExceeded?: LooseOptional<boolean>
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
      capacityExceeded: input.capacityExceeded,
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
      capacityExceeded: input.capacityExceeded,
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
    if (this.reports.length > AgentTuning.residency.maxRetainedEpochReports) {
      this.reports.splice(0, this.reports.length - AgentTuning.residency.maxRetainedEpochReports)
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
    // 阶段请求在重建前已按稳定调用身份完成差分；保留这份独立于记录编号的待消费状态。
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

