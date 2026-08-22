/**
 * `ProviderRequestCompiler` 是第一环治理管线的装配入口，也是 `ContextAssembler` 的正式实现。
 *
 * B1 将原先彼此独立的历史压缩路径统一为驻留账本：会话历史先由
 * `ContextGovernanceSession.syncHistory` 增量摄入，在轮边界由 `governTurn` 执行唯一治理，
 * 最后由 `projectContextLedger` 确定性投影。结构清洗、保留上下文和预算钳制仍各守原有职责。
 *
 * 治理未触发时，账本记录均为内联态，投影保持原消息对象与顺序，编译结果与清洗后的历史逐字节
 * 等价。只有真正执行过治理周期，投影才会变化。
 *
 * `tailBlocks` 是易变内容的唯一合法位置；动态系统提示、上下文仪表盘和保留上下文均排在历史之后，
 * 避免每轮击穿稳定前缀缓存。
 *
 * 提示词缓存断点属于回合本地装饰，必须在账本投影之后、活动尾之前添加。账本只摄入未装饰历史，
 * 防止同一用户消息因断点迁移而改变指纹、触发整本账本重建；提供方最终收到的字节保持不变。
 */
import type { ModelMessage } from 'ai'

import {
  type ContextUsageEstimate,
  estimateContextUsage,
  type EstimateContextUsageOptions,
} from '@velaros-ai/agent'
import { isArray, isEmpty, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ProviderRequestFingerprint } from '../../kernel/provider-events'
import { rewriteCanonicalToolReferences } from '../../tools/ToolIdentity'
import { assertValidModelHistory } from '../history/validate'
import { markLatestUserMessagePromptCacheBreakpoint } from '../model'

import {
  assertProviderRequestInvariants,
  buildProviderRequestFingerprint,
} from './providerRequest/floor'
import {
  buildProviderHistoryRewriteFingerprint,
  createProviderRequestScratch,
  resolveSharedToolReferenceScan,
} from './providerRequest/pipeline'
import { resolveToolSchemaReserve, runBudgetStage } from './providerRequest/stages/budgetStage'
import { applyHistoryStructureRepair } from './providerRequest/stages/historySanitizeStage'
import {
  buildRetainedContextRewriteSignals,
  withProviderVisibleRetainedContext,
} from './providerRequest/stages/retainedContextStage'
import { estimateMessageChars } from './residency/messageFacts'
import type { ContextLedgerEntry } from './ContextLedger'
import {
  type ContextActiveTaskInput,
  type ContextPinnedEvidenceInput,
  type ContextResourceStateInput,
  ContextWorkingSetOS,
  type ContextWorkingSetRetrievalHandleInput,
} from './ContextWorkingSetOS'
import type {
  ContextWorkingSetReclaimAction,
  ContextWorkingSetZoneId,
} from './ContextWorkingSetZones'
import {
  buildProviderRequestSnapshot,
  type ProviderRequestSnapshot,
  type ProviderToolDefinitionSnapshotInput,
} from './ProviderRequestSnapshot'
import {
  buildContextDashboardMessage,
  type ContextGovernanceSession,
  ContextGovernanceSessionRegistry,
  type ContextHandoffSignal,
  type ContextProjectionStats,
  DefaultResidencyCharsPerToken,
  type GovernanceEpochReport,
  type GovernanceWindowDerivation,
  projectContextLedger,
  resolveProjectionBudget,
} from './residency'

export {
  collectProviderRequestHistoryToolNames,
  isSerializedContextRefCandidateText,
} from './providerRequest/messageScan'

const log = logRuntime.tag('ProviderRequestCompiler')

/** 无 sessionId 时的一次性治理会话键：账本仍生效，只是不与任何真实会话共享跨回合状态。 */
const EphemeralGovernanceSessionId = '__ephemeral-governance-session__'

export interface CompileProviderRequestInput {
  model: string
  systemPrompt: string
  messages: ModelMessage[]
  /** 会话标识；提供后治理账本跨回合存活（缺省则本轮一次性账本，治理退化为纯准入）。 */
  sessionId?: string
  /**
   * 治理账本键（缺省 = `sessionId`）。
   *
   * 只有一种情况要与 `sessionId` 分开：子 agent 与父会话共用 sessionId（`sessionId` 还要给
   * PayloadStore 当分区，改不得），但它们是两条完全不同的消息序列，共用一本账本会让父子交替编译
   * 每次都在第 0 条指纹分叉 → 整本重建（审计 U12）。
   */
  governanceSessionId?: LooseOptional<string>
  /**
   * 是否贴发送面传输装饰（prompt-cache 断点）。
   *
   * 只有**真的要发出去**的编译才开。默认关：`compile()` 因此保持"账本进、投影出"的纯粹形态，
   * 治理未触发时出口与摄入逐字等价这条断言锁不受装饰干扰。
   */
  applySendTransportDecorations?: LooseOptional<boolean>
  availableToolNames?: readonly string[]
  toolChoiceName?: LooseOptional<string>
  toolSchemaChars?: Record<string, number>
  toolSchemaHashes?: Record<string, string>
  providerTools?: readonly ProviderToolDefinitionSnapshotInput[]
  providerToolChoice?: unknown
  toolPayloadRefsByToolCallId?: Record<string, string>
  /** 超长 user 正文的内容哈希 → 持久 payloadRef；准入信封用它跨进程精确召回。 */
  userTextPayloadRefsByHash?: Readonly<Record<string, string>>
  retrievalHandles?: ContextWorkingSetRetrievalHandleInput[]
  activeTask?: LooseOptional<ContextActiveTaskInput>
  pinnedEvidence?: readonly ContextPinnedEvidenceInput[]
  resourceState?: LooseOptional<ContextResourceStateInput>
  contextUsageOptions?: EstimateContextUsageOptions
  contextWindow?: LooseOptional<number>
  reservedOutputTokens?: LooseOptional<number>
  safetyMarginPercent?: LooseOptional<number>
  calibrationFactor?: LooseOptional<number>
  /**
   * 活动尾块：系统提示词 dynamic 层、turn-context 增量等**逐轮易变**的注入内容。
   * 排在账本投影之后，永不进稳定前缀（P7-1）。
   */
  tailBlocks?: readonly ModelMessage[]
  historyRewriteSignals?: readonly ProviderHistoryRewriteSignal[]
  /** canonical tool id → provider-safe request-local name. Persistent history remains canonical. */
  toolNameAliases?: Readonly<Record<string, string>>
}

export type ProviderRequestPressureKind =
  | 'none'
  | 'tokens'
  | 'payload'
  | 'tool-schema'
  | 'mixed'

export interface ProviderRequestCompileDecision {
  okToSend: boolean
  pressureKind: ProviderRequestPressureKind
  reason: string
  zoneDiagnostics: ProviderRequestZoneDiagnostic[]
}

export interface ProviderRequestZoneDiagnostic {
  zone: ContextWorkingSetZoneId
  usedTokens: number
  effectiveLimitTokens: number
  overBudgetTokens: number
  reclaimOrder: ContextWorkingSetReclaimAction[]
}

export interface CompiledProviderRequest {
  system: string
  messages: ModelMessage[]
  ledger: ContextLedgerEntry[]
  estimate: ContextUsageEstimate
  decision: ProviderRequestCompileDecision
  requestFingerprint: ProviderRequestFingerprint
  /** 真实组装终点的可持久化请求快照；发送前由 turn 路径校验完整性。 */
  providerRequest: ProviderRequestSnapshot
  /** 本轮跑过的治理 epoch 报告；未触发时为 null。 */
  governanceEpoch?: LooseOptional<GovernanceEpochReport>
  /** 会话累计已应用的 epoch 代数（跳过的 epoch 不计代，与 dashboard 上的号同源）。 */
  governanceEpochSeq?: LooseOptional<number>
  /** 治理后的投影占用（token）与驻留态计数，供调试面与 scoreboard 消费。 */
  governanceOccupancyPercent?: LooseOptional<number>
  /**
   * 转交信号（设计 §4）。B1 起送核门失去回收阶梯的二次挽救，**压力的唯一出路是转交**，
   * 所以这条信号必须沿编译结果一路出到壳侧的布防看门，不能只留在治理器内部。
   */
  governanceHandoff?: LooseOptional<ContextHandoffSignal>
  historyRewriteFingerprint?: string
}

export interface ProviderHistoryRewriteSignal {
  kind: string
  details: unknown
}

export class ProviderRequestCompiler {
  private readonly workingSetOS = new ContextWorkingSetOS()

  constructor(
    /**
     * 治理会话登记处（宿主级单实例，账本跨回合的家）。缺省自建一份——单宿主进程里这等价于
     * 注入，多宿主同进程装配才需要显式共享同一份实例。
     */
    private readonly governanceSessions: ContextGovernanceSessionRegistry = new ContextGovernanceSessionRegistry()
  ) {}

  public compile(input: CompileProviderRequestInput): CompiledProviderRequest {
    return this.compileInternal(input)
  }

  /**
   * 编译入口（保留 `compileWithReclaim` 名以免调用面大改）。
   *
   * B1 起**没有回收阶梯**：压力的唯一出路是轮边界的 GovernanceEpoch，epoch 之后仍超预算说明
   * 该开新会话（转交信号），不是再压一遍。v1 的 pass 间回收每次都全量重编译并重写历史视图，
   * 是"缓存毁灭者"里最贵的一条。
   */
  public compileWithReclaim(input: CompileProviderRequestInput): CompiledProviderRequest {
    return this.compileInternal(input)
  }

  private compileInternal(input: CompileProviderRequestInput): CompiledProviderRequest {
    const scratch = createProviderRequestScratch()
    const at = Date.now()

    // stage ①：编译前结构自愈（孤儿 tool-result 会永久锁死会话，这条是救命逻辑）。
    const sanitizedMessages = applyHistoryStructureRepair(input.messages, { log: true })
    assertValidModelHistory(sanitizedMessages, { phase: 'compile', turn: null })

    // 账本单口：摄入 → 轮边界治理 → 确定性投影。
    //
    // **稳定前缀不进账本**：开头那串 system 消息是系统提示词稳定层，工具清单一变它就变。若把它
    // 当普通记录摄入，前缀比对每次都会在第 0 条分叉 → 整本账本重建 → 驻留态、faultCount、epoch
    // 号全部清零。它本来就该走投影的 `stablePrefix` 通道（设计 §3 的三段布局）。
    const { stablePrefix, body } = partitionStablePrefix(sanitizedMessages)
    const governance = this.runGovernance(input, body, stablePrefix, at)
    const projection = projectContextLedger({
      records: governance.session.ledger.list(),
      residency: governance.session.ledger.residencyVector(),
      budget: resolveProjectionBudget(
        governance.session.config,
        governance.window.windowTokens,
        governance.ruler.charsPerToken
      ),
      stablePrefix,
    })
    // 传输装饰贴在投影**之后**（见文件头）：账本摄入的是未装饰历史，装饰只作用于发出去的这一份。
    const projectedMessages = applySendTransportDecorations(projection.messages, input)

    // 工作集分类：为保留上下文（③）与预算（⑥）提供 blocks 单源。
    const classified = this.workingSetOS.classify({
      systemPrompt: input.systemPrompt,
      messages: projectedMessages,
      toolSchemaChars: input.toolSchemaChars,
      retrievalHandles: input.retrievalHandles,
      activeTask: input.activeTask,
      pinnedEvidence: input.pinnedEvidence,
      resourceState: input.resourceState,
    })

    // stage ③ + 活动尾：保留上下文、dashboard、宿主 tailBlocks 一律排在账本投影之后。
    const retained = withProviderVisibleRetainedContext(projectedMessages, classified.blocks)
    const tailBlocks = this.buildTailBlocks(input, governance, projection.stats)
    const canonicalProviderMessages = applyHistoryStructureRepair(
      isEmpty(tailBlocks) ? retained.messages : [...retained.messages, ...tailBlocks],
      { log: false }
    )
    const toolNameAliases = input.toolNameAliases ?? {}
    const providerMessages = rewriteProviderToolNames(
      canonicalProviderMessages,
      toolNameAliases
    )
    const providerSystem = rewriteCanonicalToolReferences(input.systemPrompt, toolNameAliases)
    const providerInput = { ...input, systemPrompt: providerSystem }
    const historyRewriteFingerprint = buildProviderHistoryRewriteFingerprint([
      ...(input.historyRewriteSignals ?? []),
      ...buildGovernanceRewriteSignals(governance.report, projection.stats.ledgerFingerprint),
      ...buildRetainedContextRewriteSignals(retained),
    ])
    assertValidModelHistory(providerMessages, { phase: 'compile', turn: null })

    // Ring 0 出核地板：指纹（共享扫描）+ 不变量校验，出核前必过。
    const requestFingerprint = buildProviderRequestFingerprint(
      providerInput,
      providerMessages,
      resolveSharedToolReferenceScan(scratch, providerMessages)
    )
    assertProviderRequestInvariants(providerInput, requestFingerprint, 'compile')
    const providerRequest = buildProviderRequestSnapshot({
      model: input.model,
      system: providerSystem,
      messages: providerMessages,
      tools: input.providerTools,
      toolChoice: input.providerToolChoice,
      requestFingerprint,
    })

    // stage ⑥：budget 钳制（估算 + 账本 + 分配 + 决策）。
    //
    // 门量的必须是**真要发出去的那份字节**（投影后 + 装饰后 + 别名改写后），所以这一次 tokenize
    // 不能省；能省的是窗口口径——`ruler` 已经把 usable/红线算过一遍，这里原样复用，不再抄公式。
    const budget = runBudgetStage({
      input: providerInput,
      providerMessages,
      classifiedBlocks: classified.blocks,
      window: governance.window,
    })

    return {
      system: providerSystem,
      messages: providerMessages,
      ledger: budget.ledger,
      estimate: budget.estimate,
      decision: budget.decision,
      requestFingerprint,
      providerRequest,
      governanceEpoch: governance.report,
      governanceEpochSeq: governance.session.epoch,
      governanceOccupancyPercent: projection.stats.occupancyPercent,
      governanceHandoff: governance.session.handoffSignal(),
      historyRewriteFingerprint,
    }
  }

  /**
   * 摄入 + 轮边界治理。
   *
   * sessionId 缺省时用一次性会话：账本仍然生效（准入规则照跑），只是跨回合状态不留 ——
   * 无身份的编译（测试 / 一次性查询）不该在 registry 里留状态。
   */
  private runGovernance(
    input: CompileProviderRequestInput,
    messages: ModelMessage[],
    stablePrefix: readonly ModelMessage[],
    at: number
  ): {
    session: ContextGovernanceSession
    report: Nullable<GovernanceEpochReport>
    window: GovernanceWindowDerivation
    ruler: ContextGovernanceRuler
  } {
    const session = this.governanceSessions.resolve(
      input.governanceSessionId?.trim() ||
        input.sessionId?.trim() ||
        EphemeralGovernanceSessionId
    )
    if (!session) throw new AppError('INVARIANT', '治理会话解析失败：sessionId 归一后仍为空')

    // 量纲先量：摄入期的准入事件也要用这把尺子记账，晚一步就又是两个数。
    const ruler = measureGovernanceRuler(input, messages, stablePrefix)
    const sync = session.syncHistory({
      messages,
      at,
      payloadRefsByToolCallId: input.toolPayloadRefsByToolCallId,
      userTextPayloadRefsByHash: input.userTextPayloadRefsByHash,
      charsPerToken: ruler.charsPerToken,
    })
    if (sync.rebuilt) {
      log.info('governance ledger rebuilt: provider history prefix diverged', {
        sessionId: input.sessionId,
        messages: messages.length,
      })
    }

    const report = session.governTurn({
      at,
      modelWindowTokens: input.contextWindow ?? input.contextUsageOptions?.contextWindow,
      reservedOutputTokens:
        input.reservedOutputTokens ?? input.contextUsageOptions?.reservedOutputTokens,
      safetyMarginPercent:
        input.safetyMarginPercent ?? input.contextUsageOptions?.safetyMarginPercent,
      fixedOverheadTokens: ruler.fixedOverheadTokens,
      charsPerToken: ruler.charsPerToken,
    })
    // G 只有一个来源：治理会话刚解析出来的那一份。编译器抄一份 min(窗口, cap) 的旧写法已删
    // （ledger-core 优化第 3 条：抄本必漂——投影按抄本裁、epoch 按原本判，两边差一格就是幽灵）。
    return { session, report, window: session.governanceWindow(), ruler }
  }

  private buildTailBlocks(
    input: CompileProviderRequestInput,
    governance: {
      session: ContextGovernanceSession
      window: GovernanceWindowDerivation
    },
    stats: ContextProjectionStats
  ): ModelMessage[] {
    const blocks = [...(input.tailBlocks ?? [])]
    if (!governance.session.config.dashboard) return blocks

    const ledger = governance.session.ledger
    const dashboard = buildContextDashboardMessage({
      epoch: governance.session.epoch,
      stats: ledger.stats(),
      records: ledger.list(),
      residency: ledger.residencyVector(),
      projectedTokens: stats.projectedTokens,
      budgetTokens: governance.window.windowTokens,
    })
    if (dashboard) blocks.push(dashboard)
    return blocks
  }
}

/**
 * 发送面传输装饰：prompt-cache 断点。
 *
 * "只对最新那条 user 消息生效、下一轮就换位"的回合本地改写，所以必须在账本投影之后贴。
 * 位置与它过去在 `compileProviderSendRequest` 里的位置一致（活动尾拼接之前），provider
 * 收到的字节不变。
 */
function applySendTransportDecorations(
  messages: ModelMessage[],
  input: CompileProviderRequestInput
): ModelMessage[] {
  if (!input.applySendTransportDecorations) return messages

  return markLatestUserMessagePromptCacheBreakpoint(messages)
}

/** 本轮治理量纲：一次 tokenize 出两个数（密度 + 账本正文之外的固定开销）。 */
interface ContextGovernanceRuler {
  /** 字符/token 密度（账本正文字符 → token 的换算尺）。 */
  charsPerToken: number
  /** 系统提示词 + 工具清单/schema + 稳定前缀 + 活动尾折成的 token 数。 */
  fixedOverheadTokens: number
}

/** 密度的合法区间：极端 tokenizer / 异常样本也不得把治理器推到无穷敏感或完全失明。 */
const MinHistoryCharsPerToken = 0.25
const MaxHistoryCharsPerToken = 8

/**
 * 本轮治理量纲的**唯一一次实测**：一次实测，两处消费（密度 + 固定开销）。
 *
 * 密度：驻留账本以正文字符记账，而字符与 token 的比值随语言、结构化载荷、分词器大幅变化。
 * 固定按 4 折算会把中文与结构化数据密集的长会话低估数倍，治理 epoch 于是在模型已被旧轨迹
 * 淹没之后仍不触发。这里复用出核预算的同一把分词尺与校准系数把它量出来。
 *
 * 固定开销：送核门算的是「系统提示词 + 工具清单 + 稳定前缀 + 活动尾 + 账本正文」，账本只管
 * 最后一项；治理窗口不把前四项扣掉，看到的占用就结构性地小于门看到的（审计 #4）。
 */
function measureGovernanceRuler(
  input: CompileProviderRequestInput,
  messages: readonly ModelMessage[],
  stablePrefix: readonly ModelMessage[]
): ContextGovernanceRuler {
  const estimateOptions = input.contextUsageOptions ?? {}
  const bodyChars = sumMessageChars(messages)
  // 开销按同一把密度尺折算，口径因此闭合：账本 + 开销 == 全量字符 ÷ 密度，账面不自相矛盾。
  // 治理**之后**才产出的两块（`context-dashboard` 与保留上下文）刻意留在开销之外——
  // 它们在这一刻还不存在，连同两把尺子的残差一起由 `GovernanceHeadroomRatio` 的折扣兜。
  const overheadChars =
    input.systemPrompt.length +
    sumMessageChars(stablePrefix) +
    sumMessageChars(input.tailBlocks ?? []) +
    estimateExtraContextChars(estimateOptions.extraContext)
  // 工具 schema 走 token 直给，且与送核门共用 `resolveToolSchemaReserve` 这一处回落公式：
  // 一边认 `extraEstimatedTokens`、一边按字符折，就是同一个病换个地方再犯一次。
  const schemaTokens = resolveToolSchemaReserve(input).extraEstimatedTokens
  const charsPerToken =
    bodyChars > 0
      ? resolveMeasuredCharsPerToken(input, messages, bodyChars, estimateOptions)
      : DefaultResidencyCharsPerToken

  return {
    charsPerToken,
    fixedOverheadTokens: Math.ceil(overheadChars / charsPerToken) + schemaTokens,
  }
}

function resolveMeasuredCharsPerToken(
  input: CompileProviderRequestInput,
  messages: readonly ModelMessage[],
  bodyChars: number,
  estimateOptions: EstimateContextUsageOptions
): number {
  const estimate = estimateContextUsage(input.model, '', [...messages], {
    contextWindow: input.contextWindow ?? estimateOptions.contextWindow,
    calibrationFactor: input.calibrationFactor ?? estimateOptions.calibrationFactor,
  })
  if (estimate.estimatedTokens <= 0) return DefaultResidencyCharsPerToken

  return Math.min(
    MaxHistoryCharsPerToken,
    Math.max(MinHistoryCharsPerToken, bodyChars / estimate.estimatedTokens)
  )
}

function sumMessageChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageChars(message), 0)
}

/** `extraContext`（工具清单等）也进送核门的序列化载荷，所以它属于固定开销。 */
function estimateExtraContextChars(extraContext: unknown): number {
  if (!isPresent(extraContext)) return 0

  try {
    return JSON.stringify(extraContext)?.length ?? 0
  } catch {
    // arch-guard:silent-catch-ok 开销估算不许因为一个不可序列化的宿主对象把整条编译打死。
    return 0
  }
}

function rewriteProviderToolNames(
  messages: readonly ModelMessage[],
  aliases: Readonly<Record<string, string>>
): ModelMessage[] {
  if (isEmpty(Object.keys(aliases))) return [...messages]

  return messages.map((message) => {
    if (message.role === 'user') return message

    if (isString(message.content)) {
      const content = rewriteCanonicalToolReferences(message.content, aliases)
      return content === message.content ? message : ({ ...message, content } as ModelMessage)
    }
    if (!isArray(message.content)) return message

    let changed = false
    const content = message.content.map((part) => {
      if (!isPlainObject(part)) return part
      const record = part as { type?: unknown; toolName?: unknown; text?: unknown }
      let next: Record<string, unknown> = part
      if (
        (record.type === 'tool-call' || record.type === 'tool-result') &&
        isString(record.toolName)
      ) {
        const providerName = aliases[record.toolName]
        if (providerName && providerName !== record.toolName) {
          next = { ...next, toolName: providerName }
          changed = true
        }
      }
      if (record.type === 'text' && isString(record.text)) {
        const text = rewriteCanonicalToolReferences(record.text, aliases)
        if (text !== record.text) {
          next = { ...next, text }
          changed = true
        }
      }
      return next as typeof part
    })
    return changed ? ({ ...message, content } as ModelMessage) : message
  })
}

/**
 * 切出稳定前缀：开头**连续**的 system 消息。
 *
 * 只认开头那一段是有依据的——provider 侧本来也只接受开头连续的 system 段（被 user/assistant
 * 隔开的第二段 system 会被直接拒），所以"开头连续的 system 消息"与"稳定前缀"在结构上同义。
 */
function partitionStablePrefix(messages: readonly ModelMessage[]): {
  stablePrefix: ModelMessage[]
  body: ModelMessage[]
} {
  let index = 0
  while (index < messages.length && messages[index].role === 'system') index += 1

  return { stablePrefix: messages.slice(0, index), body: messages.slice(index) }
}

/**
 * 治理改写签名。
 *
 * 只有 epoch 真正应用了迁移才算"历史被改写"——`ledgerFingerprint` 是账本段的内容指纹，进签名
 * 后前缀漂移一眼可判（缓存回归的探针）。未触发 epoch 的轮次不产签名，指纹保持为 undefined，
 * 与切换前"没有任何 stage 改写历史"的语义一致。
 */
function buildGovernanceRewriteSignals(
  report: Nullable<GovernanceEpochReport>,
  ledgerFingerprint: string
): ProviderHistoryRewriteSignal[] {
  if (!report?.applied) return []

  return [
    {
      kind: 'governance-epoch',
      details: {
        epoch: report.epoch,
        trigger: report.trigger,
        migrationCount: report.migrationCount,
        byInstrument: report.byInstrument,
        savedTokens: report.savedTokens,
        ledgerFingerprint,
      },
    },
  ]
}
