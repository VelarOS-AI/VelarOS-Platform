/**
 * ProviderRequestCompiler——Ring 1 治理管线（ContextAssembler 官方实现）的装配入口 + 公共契约。
 *
 * ## B1 换心：五条压缩路径 → 一条账本路径
 * v1 的六 stage 里有四条各自在改写历史（注意力路由逐轮打分折叠、microCompaction 最近 N 条窗口、
 * tool-result 去重/句柄化、回收阶梯 pass 间重压），彼此不知情，且**每条都在重写消息视图**——
 * 前缀字节一变，整条下游 KV 缓存全灭。B1 把它们整体换成一条路：
 *
 *   会话历史 → `ContextGovernanceSession.syncHistory`（增量摄入驻留账本）
 *           → 轮边界 `governTurn`（唯一治理点：需要时跑一次 GovernanceEpoch）
 *           → `projectContextLedger`（确定性投影，唯一 prompt 组装口）
 *
 * 剩下的 stage 各守其位、语义不变：
 *   ① history-sanitize   providerRequest/stages/historySanitizeStage（孤儿自愈，救命逻辑，保留）
 *   ③ retained-context   providerRequest/stages/retainedContextStage（provider-visible blocks）
 *   ⑥ budget             providerRequest/stages/budgetStage（预算钳制 + 出核决策）
 *
 * ## 行为对齐（切换的验收线）
 * 治理未触发时（低占用），账本全是准入态 INLINE，投影输出与摄入的消息**同一批对象、同一顺序**
 * ——编译器出口逐字节等价于切换前的"清洗后历史"。只有 epoch 真正跑过，投影才与输入不同。
 *
 * ## 活动尾（P7-1 的落点）
 * `tailBlocks` 是易变内容的唯一合法位置：系统提示词的 dynamic 层、context-dashboard、
 * retained-context 一律排在历史之后。它们放前缀里就是每请求一次全历史缓存失效。
 */
import type { ModelMessage } from 'ai'

import type {
  ContextUsageEstimate,
  EstimateContextUsageOptions,
} from '@velaros-ai/agent'
import { isArray, isEmpty, isFiniteNumber, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ProviderRequestFingerprint } from '../../kernel/provider-events'
import { rewriteCanonicalToolReferences } from '../../tools/ToolIdentity'
import { assertValidModelHistory } from '../history/validate'

import {
  assertProviderRequestInvariants,
  buildProviderRequestFingerprint,
} from './providerRequest/floor'
import {
  buildProviderHistoryRewriteFingerprint,
  createProviderRequestScratch,
  resolveSharedToolReferenceScan,
} from './providerRequest/pipeline'
import { runBudgetStage } from './providerRequest/stages/budgetStage'
import { applyHistoryStructureRepair } from './providerRequest/stages/historySanitizeStage'
import {
  buildRetainedContextRewriteSignals,
  withProviderVisibleRetainedContext,
} from './providerRequest/stages/retainedContextStage'
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
  buildContextDashboardMessage,
  type ContextGovernanceSession,
  ContextGovernanceSessionRegistry,
  type ContextHandoffSignal,
  type GovernanceEpochReport,
  projectContextLedger,
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
  availableToolNames?: readonly string[]
  toolChoiceName?: LooseOptional<string>
  toolSchemaChars?: Record<string, number>
  toolPayloadRefsByToolCallId?: Record<string, string>
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
    const governance = this.runGovernance(input, body, at)
    const projection = projectContextLedger({
      records: governance.session.ledger.list(),
      residency: governance.session.ledger.residencyVector(),
      budget: {
        tailProtectTurns: governance.session.config.tailProtectTurns,
        budgetTokens: governance.budgetTokens,
      },
      stablePrefix,
    })

    // 工作集分类：为保留上下文（③）与预算（⑥）提供 blocks 单源。
    const classified = this.workingSetOS.classify({
      systemPrompt: input.systemPrompt,
      messages: projection.messages,
      toolSchemaChars: input.toolSchemaChars,
      retrievalHandles: input.retrievalHandles,
      activeTask: input.activeTask,
      pinnedEvidence: input.pinnedEvidence,
      resourceState: input.resourceState,
    })

    // stage ③ + 活动尾：保留上下文、dashboard、宿主 tailBlocks 一律排在账本投影之后。
    const retained = withProviderVisibleRetainedContext(projection.messages, classified.blocks)
    const tailBlocks = this.buildTailBlocks(input, governance, projection.stats.projectedTokens)
    const canonicalProviderMessages = applyHistoryStructureRepair(
      isEmpty(tailBlocks) ? retained.messages : [...retained.messages, ...tailBlocks],
      { log: false }
    )
    const toolNameAliases = input.toolNameAliases ?? {}
    const providerMessages = rewriteProviderToolNames(
      canonicalProviderMessages,
      toolNameAliases
    )
    const historyRewriteFingerprint = buildProviderHistoryRewriteFingerprint([
      ...(input.historyRewriteSignals ?? []),
      ...buildGovernanceRewriteSignals(governance.report, projection.stats.ledgerFingerprint),
      ...buildRetainedContextRewriteSignals(retained),
    ])
    assertValidModelHistory(providerMessages, { phase: 'compile', turn: null })

    // Ring 0 出核地板：指纹（共享扫描）+ 不变量校验，出核前必过。
    const requestFingerprint = buildProviderRequestFingerprint(
      input,
      providerMessages,
      resolveSharedToolReferenceScan(scratch, providerMessages)
    )
    assertProviderRequestInvariants(input, requestFingerprint, 'compile')

    // stage ⑥：budget 钳制（估算 + 账本 + 分配 + 决策）。
    const budget = runBudgetStage({
      input,
      providerMessages,
      classifiedBlocks: classified.blocks,
    })

    return {
      system: rewriteCanonicalToolReferences(input.systemPrompt, toolNameAliases),
      messages: providerMessages,
      ledger: budget.ledger,
      estimate: budget.estimate,
      decision: budget.decision,
      requestFingerprint,
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
    at: number
  ): {
    session: ContextGovernanceSession
    report: Nullable<GovernanceEpochReport>
    budgetTokens: number
  } {
    const session =
      this.governanceSessions.resolve(input.sessionId?.trim() || EphemeralGovernanceSessionId)
    if (!session) throw new AppError('INVARIANT', '治理会话解析失败：sessionId 归一后仍为空')

    const sync = session.syncHistory({
      messages,
      at,
      payloadRefsByToolCallId: input.toolPayloadRefsByToolCallId,
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
    })
    const budgetTokens = resolveBudgetTokens(session, input)
    return { session, report, budgetTokens }
  }

  private buildTailBlocks(
    input: CompileProviderRequestInput,
    governance: { session: ContextGovernanceSession; budgetTokens: number },
    projectedTokens: number
  ): ModelMessage[] {
    const blocks = [...(input.tailBlocks ?? [])]
    if (!governance.session.config.dashboard) return blocks

    const ledger = governance.session.ledger
    const dashboard = buildContextDashboardMessage({
      epoch: governance.session.epoch,
      stats: ledger.stats(),
      records: ledger.list(),
      residency: ledger.residencyVector(),
      projectedTokens,
      budgetTokens: governance.budgetTokens,
    })
    if (dashboard) blocks.push(dashboard)
    return blocks
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

function resolveBudgetTokens(
  session: ContextGovernanceSession,
  input: CompileProviderRequestInput
): number {
  const modelWindow = input.contextWindow ?? input.contextUsageOptions?.contextWindow
  const cap = session.config.cap
  if (!isFiniteNumber(modelWindow) || modelWindow <= 0) return cap

  return Math.min(Math.floor(modelWindow), cap)
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
