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

import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import type { ContextUsageEstimate } from '../../types/agent.js'
import type { CompiledProviderRequest, CompiledProviderSendRequest, CompileProviderRequestInput, CompileProviderSendRequestInput, ContextGovernanceRuler } from '../../types/context.js'
import type { SanitizeModelHistoryOptions, UserTextPayloadReference } from '../../types/history.js'
import type { ContextGovernanceSessionApi, ContextGovernanceSessionRegistryContract, GovernanceEpochReport, GovernanceWindowDerivation } from '../../types/residency.js'
import { estimateProviderRequestUsage, runBudgetStage } from '../../utils/context/budget-stage'
import { projectFileContext } from '../../utils/context/file-context-projection'
import { assertProviderRequestInvariants, buildProviderRequestFingerprint } from '../../utils/context/floor'
import { applyHistoryStructureRepair } from '../../utils/context/history-sanitize-stage'
import { buildProviderHistoryRewriteFingerprint, createProviderRequestScratch, resolveSharedToolReferenceScan } from '../../utils/context/pipeline'
import { applySendTransportDecorations, buildGovernanceRewriteSignals, buildProviderRequestTailBlocks, measureGovernanceRuler, partitionStablePrefix, rewriteProviderToolNames } from '../../utils/context/provider-request-compile'
import { buildProviderRequestSnapshot } from '../../utils/context/provider-request-snapshot'
import { buildRetainedContextRewriteSignals, withProviderVisibleRetainedContext } from '../../utils/context/retained-context-stage'
import { sanitizeHistoryForProvider } from '../../utils/history/request'
import { assertValidModelHistory } from '../../utils/history/validate'
import { resolveProjectionBudget } from '../../utils/residency/governance-epoch'
import { resolveGovernanceWindow } from '../../utils/residency/governance-window'
import { projectContextLedger } from '../../utils/residency/projection'
import { rewriteCanonicalToolReferences } from '../../utils/tools/tool-identity'
import { readReusableAttemptInput } from '../../utils/tools/tool-input-reuse'
import { projectTransientRecoveryHistory, restoreReusableInputsForNextDecision } from '../../utils/tools/transient-recovery-projection'
import { ContextGovernanceSessionRegistry } from '../residency/ContextGovernanceSessionRegistry'
import { ContextProjectionRenderCache } from '../residency/ContextProjectionRenderCache'

import { ContextWorkingSetOS } from './ContextWorkingSetOS'
import { fileContextRegistry } from './FileContextRegistry'
import { ToolPayloadReferencePlanner } from './ToolPayloadReferencePlanner'
import { OversizedUserTextSafetyValveChars, UserTextPayloadPlanner } from './UserTextPayloadPlanner'

export {
  collectProviderRequestHistoryToolNames,
  isSerializedContextRefCandidateText,
} from '../../utils/context/message-scan'

const log = Log.tag('ProviderRequestCompiler')

interface ProviderMessageProjection {
  projection: ReturnType<typeof projectContextLedger>
  projectedMessages: ModelMessage[]
  providerMessages: ModelMessage[]
}

/**
 * 供应商请求编译器：第一环治理管线的装配入口，也是 `ContextAssembler` 的正式实现。
 *
 * 由宿主或循环持有（构造时收下治理会话登记处，不传就自建一份），账本跨回合的家在登记处而不在本实例，
 * 所以同一份编译器可以服务多个会话。一次编译 = 结构自愈 → 账本摄入 → 轮边界治理 → 确定性投影 →
 * 保留上下文与活动尾 → 预算核算；治理没触发时结果与清洗后的历史逐字节等价。
 * 历史结构修不好（孤儿 tool-result 之类）会抛错终止本轮，绝不把半截历史发出去。
 */
export interface ProviderRequestCompilerApi {
  /** 编译一次供应商请求：吃会话历史与本轮入参，出可直接发送的 system / messages / 工具与预算快照。 */
  compile(input: CompileProviderRequestInput): CompiledProviderRequest
  /**
   * 与 `compile` 同一条路，名字为兼容旧调用面保留。
   * B1 起**没有回收阶梯**：仍超预算说明该开新会话（转交信号），不是再压一遍。
   */
  compileWithReclaim(input: CompileProviderRequestInput): CompiledProviderRequest
  /**
   * 给已编译结果封一份最终投影：重算指纹、重跑不变量断言与预算核算，但**不重跑治理、不改显示字节**。
   * 用在发送前消息又被下游动过（例如补了来源引用）的场合，让快照与真正发出去的那份对齐。
   */
  finalizeProjectedMessages(
    input: CompileProviderRequestInput,
    compiled: CompiledProviderRequest,
    messages: ModelMessage[]
  ): CompiledProviderRequest
  /**
   * 统一的模型请求发送路径：先持久化超大用户文本，再清洗历史消息，按需构建工具引用与源码窗口，
   * 最后走 `compileWithReclaim` 编译出可发送请求。调用方不该在此之前重复做历史清洗或用户文本安全阀。
   * 与 `compile` 的区别是它吃**未清洗的原始历史**（`rawHistoryMessages`），并额外回报清洗后的历史
   * 与本轮持久化的用户文本条数。
   */
  compileSendRequest(input: CompileProviderSendRequestInput): Promise<CompiledProviderSendRequest>
}

export class ProviderRequestCompiler implements ProviderRequestCompilerApi {
  /** 无 sessionId 时的一次性治理会话键：账本仍生效，只是不与任何真实会话共享跨回合状态。 */
  private static readonly EphemeralGovernanceSessionId = '__ephemeral-governance-session__'

  private readonly workingSetOS = new ContextWorkingSetOS()
  /**
   * 投影渲染长度的复用缓存。投影本身是纯函数，缓存的家在这里：编译器长活，账本记录一旦入账不再改写，
   * 所以同一条记录同一驻留态只渲染一次，之后每轮（以及同一轮里治理前预判与治理后发送两次投影）直接命中。
   */
  private readonly renderCache = new ContextProjectionRenderCache()

  constructor(
    /**
     * 治理会话登记处（宿主级单实例，账本跨回合的家）。缺省自建一份——单宿主进程里这等价于
     * 注入，多宿主同进程装配才需要显式共享同一份实例。
     */
    private readonly governanceSessions: ContextGovernanceSessionRegistryContract = new ContextGovernanceSessionRegistry()
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

  /**
   * 统一模型请求发送路径：先持久化超大用户文本，再清洗历史消息，再按需构建工具引用，最后编译可发送请求。
   * 调用方不应在此之前重复执行历史清洗或用户文本安全阀逻辑。
   */
  public async compileSendRequest(
    input: CompileProviderSendRequestInput
  ): Promise<CompiledProviderSendRequest> {
    let userTextPayloadRefs: UserTextPayloadReference[] = []
    let storedToolPayloadRefs: Record<string, string> = {}
    const mergedSanitizeOptions: SanitizeModelHistoryOptions = {
      stripProviderSpecificMetadata: true,
      ...(input.sanitizeOptions ?? {}),
    }

    const sanitizedHistoryMessages = sanitizeHistoryForProvider(
      input.rawHistoryMessages,
      input.phase,
      toNullable(input.turn),
      mergedSanitizeOptions
    )
    if (input.payloadStore && !input.skipUserTextPersistence) {
      const planner = new UserTextPayloadPlanner(input.payloadStore)
      const persisted = await planner.persistOversizedUserTexts({
        sessionId: input.sessionId,
        // 先做结构/Unicode 清洗再计算内容哈希，准入期对同一份正文重算时才能稳定命中。
        messages: sanitizedHistoryMessages,
        thresholdChars: OversizedUserTextSafetyValveChars,
      })
      userTextPayloadRefs = persisted.references
    }
    // 生产发送路径会注入 buildToolPayloadRefs，并由工具描述决定 outputInline；此时不能再跑一遍不懂
    // 工具策略的通用规划器，否则会给本应永久内联的结果补上 ref。无宿主回调时才用通用持久化兜底。
    if (input.payloadStore && !input.buildToolPayloadRefs) {
      storedToolPayloadRefs = await new ToolPayloadReferencePlanner(input.payloadStore).buildRefs({
        sessionId: input.sessionId,
        messages: input.rawHistoryMessages,
        store: input.payloadStore,
      })
    }
    const leadingMessages = input.leadingMessages ?? []
    // 交给编译器的是**未装饰**的历史：prompt-cache 断点每轮换位，贴在这里
    // 会让驻留账本的前缀指纹在每个新用户回合分叉、整本重建（审计 V10/U2/U4）。装饰改由编译器在
    // 投影之后贴（`applySendTransportDecorations`），provider 收到的字节不变。
    const fileContext = input.toolContext ? fileContextRegistry.for(input.toolContext) : undefined
    await fileContext?.seedHistory(sanitizedHistoryMessages)
    await fileContext?.prepare()
    const fileViews = fileContext?.currentViews() ?? []
    const measurementInput = { ...input, messages: sanitizedHistoryMessages }
    const fixedEstimate = estimateProviderRequestUsage(measurementInput, [...leadingMessages, ...(input.tailBlocks ?? [])])
    const fileTokenBudget = Math.max(0, Math.min(fixedEstimate.usableContextWindow * 0.15,
      fixedEstimate.usableContextWindow - fixedEstimate.estimatedTokens))
    let fileChars = Math.min(32_000, Math.floor(fileTokenBudget * 3))
    // 失败回执与被复用的原参数只陪紧接着的那一次决策；attempt 记录与工具执行共用同一会话的存储。
    const attemptStore = input.toolContext?.contextPayloadStore ?? input.payloadStore
    const attemptSessionId = input.toolContext?.sessionId ?? input.sessionId
    const recovery = await restoreReusableInputsForNextDecision(
      projectTransientRecoveryHistory(sanitizedHistoryMessages),
      async (toolCallId) => attemptStore
        ? readReusableAttemptInput(attemptStore, attemptSessionId, toolCallId)
        : undefined,
    )
    const recoveryHistory = recovery.messages
    // 标题与回执说明由登记来源声明；来源不声明就不出这段正文（见 FileContextPresentation）。
    const filePresentation = fileContext?.listSources().find((source) => source.presentation)?.presentation
    let fileProjection = projectFileContext(recoveryHistory, fileViews, fileChars, filePresentation)
    // 与最终发送门共用分词尺；源码预算是总输入容量的一部分，最后仍由编译器统一准入。
    while (fileChars > 0 && estimateProviderRequestUsage(measurementInput,
      [...leadingMessages, ...(input.tailBlocks ?? []), ...fileProjection.tail]).estimatedTokens
        - fixedEstimate.estimatedTokens > fileTokenBudget) {
      fileChars = Math.floor(fileChars / 2)
      fileProjection = projectFileContext(recoveryHistory, fileViews, fileChars, filePresentation)
    }
    const undecoratedMessages = [...leadingMessages, ...fileProjection.history]
    const callbackToolPayloadRefs = input.buildToolPayloadRefs
      ? await input.buildToolPayloadRefs(undecoratedMessages)
      : undefined
    const mergedToolPayloadRefs = {
      ...storedToolPayloadRefs,
      ...(callbackToolPayloadRefs ?? {}),
    }
    const toolPayloadRefsByToolCallId = isEmpty(Object.keys(mergedToolPayloadRefs))
      ? undefined
      : mergedToolPayloadRefs
    const userTextPayloadRefsByHash = Object.fromEntries(
      userTextPayloadRefs.map((reference) => [reference.hash, reference.payloadRef])
    )

    const compileInput = {
      ...input,
      messages: undecoratedMessages,
      tailBlocks: [...(input.tailBlocks ?? []), ...fileProjection.tail],
      preserveToolCallInputIds: recovery.restoredToolCallIds,
      applySendTransportDecorations: true,
      toolPayloadRefsByToolCallId,
      userTextPayloadRefsByHash,
      toolNameAliases:
        input.toolNameAliases ?? input.toolContext?.getCurrentVisibleToolTransportNames?.(),
    }
    let compiled = this.compileWithReclaim(compileInput)

    // 全部裁剪完成后再签发引用，并按最终字节重新封存 token 估计
    // 与完整性指纹，避免源码授权破坏发送边界快照。
    if (fileContext) compiled = this.finalizeProjectedMessages(
      compileInput, compiled, await fileContext.finalizeMessages(compiled.messages)
    )

    return {
      ...compiled,
      sanitizedHistoryMessages,
      providerMessages: compiled.messages,
      userTextPayloadRefs: userTextPayloadRefs.length,
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
        ProviderRequestCompiler.EphemeralGovernanceSessionId
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
      renderCache: this.renderCache,
    })
    const projectedMessages = applySendTransportDecorations(projection.messages, input)
    const tailBlocks = buildProviderRequestTailBlocks(input, { session, window }, projection.stats)
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

}

export function compileProviderSendRequest(
  input: CompileProviderSendRequestInput,
  compiler: ProviderRequestCompilerApi
): Promise<CompiledProviderSendRequest> {
  return compiler.compileSendRequest(input)
}

/** 建一台 provider 请求编译器；不注入治理登记处就自己建一份独占的。 */
export function createProviderRequestCompiler(governanceSessions: ContextGovernanceSessionRegistryContract = new ContextGovernanceSessionRegistry()): ProviderRequestCompilerApi {
  return new ProviderRequestCompiler(governanceSessions)
}
