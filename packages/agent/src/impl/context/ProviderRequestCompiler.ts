/**
 * `ProviderRequestCompiler` 是第一环治理管线的装配入口，也是 `ContextAssembler` 的正式实现。
 *
 * B1 将原先彼此独立的历史压缩路径统一为驻留账本：会话历史先由
 * `ContextGovernanceSessionApi.syncHistory` 增量摄入，在轮边界由 `governTurn` 执行唯一治理，
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

import { isNotNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ContextUsageEstimate } from '../../types/agent.js'
import type { CompiledProviderRequest, CompileProviderRequestInput, ContextGovernanceRuler } from '../../types/context.js'
import type { ContextGovernanceSessionApi, ContextGovernanceSessionRegistryApi } from '../../types/residency.js'
import type { ContextProjectionStats, GovernanceEpochReport,GovernanceWindowDerivation } from '../../types/residency.js'
import { estimateProviderRequestUsage, runBudgetStage } from '../../utils/context/budget-stage'
import { ContextWorkingSetOS } from '../../utils/context/context-working-set-os'
import {
  assertProviderRequestInvariants,
  buildProviderRequestFingerprint,
} from '../../utils/context/floor'
import { applyHistoryStructureRepair } from '../../utils/context/history-sanitize-stage'
import {
  buildProviderHistoryRewriteFingerprint,
  createProviderRequestScratch,
  resolveSharedToolReferenceScan,
} from '../../utils/context/pipeline'
import { applySendTransportDecorations, buildGovernanceRewriteSignals, measureGovernanceRuler, partitionStablePrefix, rewriteProviderToolNames } from '../../utils/context/provider-request-compile'
import { buildProviderRequestSnapshot } from '../../utils/context/provider-request-snapshot'
import {
  buildRetainedContextRewriteSignals,
  withProviderVisibleRetainedContext,
} from '../../utils/context/retained-context-stage'
import { assertValidModelHistory } from '../../utils/history/validate'
import { buildContextDashboardMessage } from '../../utils/residency/dashboard'
import { resolveProjectionBudget } from '../../utils/residency/governance-epoch'
import { resolveGovernanceWindow } from '../../utils/residency/governance-window'
import { projectContextLedger } from '../../utils/residency/projection'
import { rewriteCanonicalToolReferences } from '../../utils/tools/tool-identity'
import { ContextGovernanceSessionRegistry } from '../residency/ContextGovernanceSessionRegistry'

export {
  collectProviderRequestHistoryToolNames,
  isSerializedContextRefCandidateText,
} from '../../utils/context/message-scan'

const log = logRuntime.tag('ProviderRequestCompiler')

/** 无 sessionId 时的一次性治理会话键：账本仍生效，只是不与任何真实会话共享跨回合状态。 */
const EphemeralGovernanceSessionId = '__ephemeral-governance-session__'

interface ProviderMessageProjection {
  projection: ReturnType<typeof projectContextLedger>
  projectedMessages: ModelMessage[]
  providerMessages: ModelMessage[]
}

export class ProviderRequestCompiler {
  private readonly workingSetOS = new ContextWorkingSetOS()

  constructor(
    /**
     * 治理会话登记处（宿主级单实例，账本跨回合的家）。缺省自建一份——单宿主进程里这等价于
     * 注入，多宿主同进程装配才需要显式共享同一份实例。
     */
    private readonly governanceSessions: ContextGovernanceSessionRegistryApi = new ContextGovernanceSessionRegistry()
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

  /** Seal a final source-reference projection without rerunning governance or altering its displayed bytes. */
  public finalizeProjectedMessages(
    input: CompileProviderRequestInput,
    compiled: CompiledProviderRequest,
    messages: ModelMessage[]
  ): CompiledProviderRequest {
    const providerInput = { ...input, systemPrompt: compiled.system }
    assertValidModelHistory(messages, { phase: 'compile', turn: null })
    const scratch = createProviderRequestScratch()
    const requestFingerprint = buildProviderRequestFingerprint(providerInput, messages, resolveSharedToolReferenceScan(scratch, messages))
    assertProviderRequestInvariants(providerInput, requestFingerprint, 'compile')
    const classified = this.workingSetOS.classify({
      systemPrompt: compiled.system, messages,
      toolSchemaChars: input.toolSchemaChars, retrievalHandles: input.retrievalHandles,
    })
    const budget = runBudgetStage({ input: providerInput, providerMessages: messages, classifiedBlocks: classified.blocks })
    return {
      ...compiled, ...budget, messages, requestFingerprint,
      providerRequest: buildProviderRequestSnapshot({
        model: input.model, system: compiled.system, messages,
        tools: input.providerTools, toolChoice: input.providerToolChoice, requestFingerprint,
      }),
    }
  }

  private compileInternal(input: CompileProviderRequestInput): CompiledProviderRequest {
    const scratch = createProviderRequestScratch()
    const at = Date.now()

    // stage ①：编译前结构自愈（孤儿 tool-result 会永久锁死会话，这条是救命逻辑）。
    const sanitizedMessages = applyHistoryStructureRepair(input.messages, {
      log: true,
      preserveToolCallInputIds: input.preserveToolCallInputIds,
    })
    assertValidModelHistory(sanitizedMessages, { phase: 'compile', turn: null })

    // 账本单口：摄入 → 轮边界治理 → 确定性投影。
    //
    // **稳定前缀不进账本**：开头那串 system 消息是系统提示词稳定层，工具清单一变它就变。若把它
    // 当普通记录摄入，前缀比对每次都会在第 0 条分叉 → 整本账本重建 → 驻留态、faultCount、epoch
    // 号全部清零。它本来就该走投影的 `stablePrefix` 通道（设计 §3 的三段布局）。
    const { stablePrefix, body } = partitionStablePrefix(sanitizedMessages)
    // 保留上下文只依赖本轮任务与证据，不依赖历史驻留态；先构造同一份消息，再计量和发送。
    const retainedBlocks = this.workingSetOS.classifyRetainedContext(input)
    const retained = withProviderVisibleRetainedContext([], retainedBlocks)
    const governance = this.runGovernance(input, body, stablePrefix, retained.messages, at)
    const { projectedMessages, projection, providerMessages } = governance.report?.applied
      ? this.projectProviderMessages(
          input, governance.session, governance.window, stablePrefix, retained.messages, governance.ruler.charsPerToken
        )
      : governance.preview

    // 工作集分类：为保留上下文（③）与预算（⑥）提供 blocks 单源。
    const classified = this.workingSetOS.classify({
      systemPrompt: input.systemPrompt,
      messages: projectedMessages,
      toolSchemaChars: input.toolSchemaChars,
      retrievalHandles: input.retrievalHandles,
    })
    // 顺序延续 kernel → 保留区 → 消息/工具区；已计量的证据不再序列化和分类第二次。
    classified.blocks.splice(1, 0, ...retainedBlocks)

    const toolNameAliases = input.toolNameAliases ?? {}
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
      estimate: governance.report?.applied ? undefined : governance.previewEstimate,
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
    retainedMessages: readonly ModelMessage[],
    at: number
  ): {
    session: ContextGovernanceSessionApi
    report: Nullable<GovernanceEpochReport>
    window: GovernanceWindowDerivation
    ruler: ContextGovernanceRuler
    preview: ProviderMessageProjection
    previewEstimate: ContextUsageEstimate
  } {
    const session = this.governanceSessions.resolve(
      input.governanceSessionId?.trim() ||
        input.sessionId?.trim() ||
        EphemeralGovernanceSessionId
    )
    if (!session) throw new AppError('INVARIANT', '治理会话解析失败：sessionId 归一后仍为空')

    // 量纲先量：摄入期的准入事件也要用这把尺子记账，晚一步就又是两个数。
    const ruler = measureGovernanceRuler(input, messages, stablePrefix, retainedMessages)
    const sync = session.syncHistory({
      deferOversizeExcerpt: true,
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

    const windowInput = {
      modelWindowTokens: input.contextWindow ?? input.contextUsageOptions?.contextWindow,
      reservedOutputTokens: input.reservedOutputTokens ?? input.contextUsageOptions?.reservedOutputTokens,
      safetyMarginPercent: input.safetyMarginPercent ?? input.contextUsageOptions?.safetyMarginPercent,
      fixedOverheadTokens: ruler.fixedOverheadTokens,
    }
    const preview = this.projectProviderMessages(
      input, session, resolveGovernanceWindow(session.config, windowInput), stablePrefix, retainedMessages, ruler.charsPerToken
    )
    const previewEstimate = estimateProviderRequestUsage({
      ...input,
      systemPrompt: rewriteCanonicalToolReferences(input.systemPrompt, input.toolNameAliases ?? {}),
    }, preview.providerMessages)
    const report = session.governTurn({
      capacityExceeded: previewEstimate.estimatedTokens > previewEstimate.usableContextWindow,
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
    return { session, report, window: session.governanceWindow(), ruler, preview, previewEstimate }
  }

  /** 治理前容量预判与治理后发送复用同一条投影/活动尾/工具别名路径。 */
  private projectProviderMessages(
    input: CompileProviderRequestInput,
    session: ContextGovernanceSessionApi,
    window: GovernanceWindowDerivation,
    stablePrefix: readonly ModelMessage[],
    retainedMessages: readonly ModelMessage[],
    charsPerToken: number
  ): ProviderMessageProjection {
    const projection = projectContextLedger({
      records: session.ledger.list(),
      residency: session.ledger.residencyVector(),
      budget: resolveProjectionBudget(session.config, window.windowTokens, charsPerToken),
      stablePrefix,
    })
    const projectedMessages = applySendTransportDecorations(projection.messages, input)
    const tailBlocks = this.buildTailBlocks(input, { session, window }, projection.stats)
    const canonicalMessages = applyHistoryStructureRepair(
      [...projectedMessages, ...retainedMessages, ...tailBlocks],
      { log: false, preserveToolCallInputIds: input.preserveToolCallInputIds }
    )
    return {
      projectedMessages,
      projection,
      providerMessages: rewriteProviderToolNames(canonicalMessages, input.toolNameAliases ?? {}),
    }
  }

  private buildTailBlocks(
    input: CompileProviderRequestInput,
    governance: {
      session: ContextGovernanceSessionApi
      window: GovernanceWindowDerivation
    },
    stats: ContextProjectionStats
  ): ModelMessage[] {
    const blocks = [...(input.tailBlocks ?? [])]
    if (!governance.session.config.dashboard) return blocks

    const ledger = governance.session.ledger
    const lastEpochAttempt = governance.session
      .epochReports()
      .findLast((report) =>
        isNotNull(report.trigger) && report.ledgerGeneration === governance.session.generation
      )
    const dashboard = buildContextDashboardMessage({
      epoch: governance.session.epoch,
      stats: ledger.stats(),
      records: ledger.list(),
      residency: ledger.residencyVector(),
      projectedTokens: stats.projectedTokens,
      budgetTokens: governance.window.windowTokens,
      lastEpochAttempt,
    })
    if (dashboard) blocks.push(dashboard)
    return blocks
  }
}

















