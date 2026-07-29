/**
 * ProviderRequestCompiler——Ring 1 治理管线（ContextAssembler 官方实现）的装配入口 + 公共契约。
 *
 * 宪章 §2 结构：出核前必过的 Ring 0 地板（`providerRequest/floor`：指纹 + 不变量）与可替换的
 * Ring 1 六 stage 物理分家——本文件只做**装配编排**与**公共契约类型**，逐 stage 逻辑各住其文件：
 *   ① history-sanitize   providerRequest/stages/historySanitizeStage（孤儿自愈）
 *   ② attention          providerRequest/stages/attentionStage（ContextAttentionRouter）
 *   ③ retained-context   providerRequest/stages/retainedContextStage（provider-visible blocks）
 *   ④ compaction         providerRequest/stages/compactionStage（microCompaction 边界 + 回收）
 *   ⑤ tool-result-rewrite providerRequest/stages/toolResultRewriteStage（去重 / 折叠）
 *   ⑥ budget             providerRequest/stages/budgetStage（预算钳制）
 * 跨 stage 共享 scratch（providerRequest/pipeline）承载单次扫描结果，禁止各 stage 重复全量扫描。
 * 行为逐字节不变：这是结构手术不是重设计。
 */
import type { ModelMessage } from 'ai'

import { logRuntime } from '@velaros-ai/core/logger'
import type { ChatContextDebugTraceEntry } from '@velaros-ai/core/types'
import type {
  ContextUsageEstimate,
  EstimateContextUsageOptions,
} from '@velaros-ai/core/utils/contextUsage'

import type { ProviderRequestFingerprint } from '../../kernel/provider-events'
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
import {
  buildAttentionRewriteSignals,
  runAttentionStage,
} from './providerRequest/stages/attentionStage'
import { runBudgetStage } from './providerRequest/stages/budgetStage'
import { runProviderRequestCompactionStage } from './providerRequest/stages/compactionStage'
import { applyHistoryStructureRepair } from './providerRequest/stages/historySanitizeStage'
import {
  buildRetainedContextRewriteSignals,
  withProviderVisibleRetainedContext,
} from './providerRequest/stages/retainedContextStage'
import {
  buildToolResultRewriteSignals,
  dedupeToolResultMessages,
} from './providerRequest/stages/toolResultRewriteStage'
import type { ContextAttentionRouterMode } from './ContextAttentionPolicyEngine'
import type {
  ContextAttentionReplayRecord,
  ContextAttentionReplayRecorder,
} from './ContextAttentionReplayRecorder'
import { ContextAttentionRouter } from './ContextAttentionRouter'
import type { ContextAttentionSessionRegistry } from './ContextAttentionSessionRegistry'
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
  buildInitialReclaimState,
  type ProviderRequestReclaimState,
  reclaimPolicyEquals,
  resolveNextReclaimState,
} from './ProviderRequestReclaim'

export {
  collectProviderRequestHistoryToolNames,
  isSerializedContextRefCandidateText,
} from './providerRequest/messageScan'

const log = logRuntime.tag('ProviderRequestCompiler')

export interface CompileProviderRequestInput {
  model: string
  systemPrompt: string
  messages: ModelMessage[]
  /** 会话标识；提供后注意力路由启用跨回合粘滞与回放落盘。 */
  sessionId?: string
  availableToolNames?: readonly string[]
  toolChoiceName?: LooseOptional<string>
  toolSchemaChars?: Record<string, number>
  toolPayloadRefsByToolCallId?: Record<string, string>
  toolPayloadReferenceBudgetChars?: LooseOptional<number>
  retrievalHandles?: ContextWorkingSetRetrievalHandleInput[]
  activeTask?: LooseOptional<ContextActiveTaskInput>
  pinnedEvidence?: readonly ContextPinnedEvidenceInput[]
  resourceState?: LooseOptional<ContextResourceStateInput>
  contextUsageOptions?: EstimateContextUsageOptions
  contextWindow?: LooseOptional<number>
  reservedOutputTokens?: LooseOptional<number>
  safetyMarginPercent?: LooseOptional<number>
  calibrationFactor?: LooseOptional<number>
  /** 测试/回放评测用的显式覆盖；生产默认 active，不走配置。 */
  contextAttentionRouterMode?: ContextAttentionRouterMode | 'off'
  contextAttentionReplayRecorder?: LooseOptional<ContextAttentionReplayRecorder>
  historyRewriteSignals?: readonly ProviderHistoryRewriteSignal[]
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
  reclaimAttempts?: number
  attentionTrace?: ChatContextDebugTraceEntry[]
  attentionReplayRecord?: ContextAttentionReplayRecord
  historyRewriteFingerprint?: string
}

export interface ProviderHistoryRewriteSignal {
  kind: string
  details: unknown
}

export class ProviderRequestCompiler {
  private readonly workingSetOS = new ContextWorkingSetOS()
  private readonly contextAttentionRouter = new ContextAttentionRouter()

  constructor(private readonly contextAttentionSessions: ContextAttentionSessionRegistry) {}

  public compile(input: CompileProviderRequestInput): CompiledProviderRequest {
    const result = this.compileInternal(
      input,
      buildInitialReclaimState(input.toolPayloadReferenceBudgetChars)
    )
    this.persistReplayRecord(input, result)
    return result
  }

  /**
   * 编译并在 okToSend=false 时按 zone reclaimOrder 迭代回收（stage ④），直到可发送或耗尽阶梯。
   */
  public compileWithReclaim(input: CompileProviderRequestInput): CompiledProviderRequest {
    let reclaimState = buildInitialReclaimState(input.toolPayloadReferenceBudgetChars)
    let reclaimAttempts = 0
    const maxReclaimAttempts = 8
    let result = this.compileInternal(
      {
        ...input,
        messages: input.messages,
        toolPayloadReferenceBudgetChars: reclaimState.referenceBudgetChars,
      },
      reclaimState
    )

    while (!result.decision.okToSend && reclaimAttempts < maxReclaimAttempts) {
      const nextState = resolveNextReclaimState(reclaimState, result.decision.zoneDiagnostics)
      // 状态不动点早停：解析器已无更紧档位（返回 null 或策略等值）→ 再压是逐字节相同的全量
      // 编译，直接停在当前结果（原实现只判 nextState 非 null，最缺预算时会做多至 7 次相同编译）。
      if (!nextState || reclaimPolicyEquals(nextState, reclaimState)) break

      reclaimState = nextState
      reclaimAttempts += 1
      const compaction = runProviderRequestCompactionStage({
        originalMessages: input.messages,
        reclaimState,
        attempts: reclaimAttempts,
      })
      result = this.compileInternal(
        {
          ...input,
          messages: compaction.messages,
          toolPayloadReferenceBudgetChars: reclaimState.referenceBudgetChars,
          historyRewriteSignals: [
            ...(input.historyRewriteSignals ?? []),
            ...compaction.rewriteSignals,
          ],
        },
        reclaimState
      )
    }

    // 只落最终 attempt 的回放记录：中间 reclaim pass 都不出核，落盘只应记真正发送的那次请求。
    this.persistReplayRecord(input, result)
    return {
      ...result,
      reclaimAttempts,
    }
  }

  /**
   * 把最终编译结果的注意力回放记录落盘（异步缓冲，非编译热路径）。只在 compile / compileWithReclaim
   * 收敛后各调用一次——中间 reclaim pass 不落盘，避免每 pass 一次冗余磁盘写。
   */
  private persistReplayRecord(
    input: CompileProviderRequestInput,
    result: CompiledProviderRequest
  ): void {
    if (!result.attentionReplayRecord) return

    const recorder =
      input.contextAttentionReplayRecorder ??
      this.contextAttentionSessions.resolveReplayRecorder(input.sessionId)
    if (!recorder) return

    try {
      recorder.record({
        ...result.attentionReplayRecord,
        requestFingerprint: result.requestFingerprint,
      })
    } catch (error) {
      log.warn('context attention replay record failed; continuing without persistence', {
        error: String(error),
      })
    }
  }

  private compileInternal(
    input: CompileProviderRequestInput,
    reclaimState: ProviderRequestReclaimState
  ): CompiledProviderRequest {
    const scratch = createProviderRequestScratch()

    // stage ⑤：tool-result 改写 / 去重。
    const toolResultDedupe = dedupeToolResultMessages(input.messages, {
      payloadRefsByToolCallId: input.toolPayloadRefsByToolCallId,
      referenceBudgetChars: Math.max(
        0,
        Math.floor(
          input.toolPayloadReferenceBudgetChars ??
            reclaimState.referenceBudgetChars ??
            Number.POSITIVE_INFINITY
        )
      ),
    })

    // stage ①：编译前结构自愈（可观测告警）。
    const sanitizedMessages = applyHistoryStructureRepair(toolResultDedupe.messages, { log: true })
    assertValidModelHistory(sanitizedMessages, { phase: 'compile', turn: null })

    // 工作集分类：为注意力（②）与保留上下文（③）提供 blocks 单源。
    const initialClassified = this.workingSetOS.classify({
      systemPrompt: input.systemPrompt,
      messages: sanitizedMessages,
      toolSchemaChars: input.toolSchemaChars,
      retrievalHandles: input.retrievalHandles,
      activeTask: input.activeTask,
      pinnedEvidence: input.pinnedEvidence,
      resourceState: input.resourceState,
    })

    // stage ②：attention（含跨回合粘滞与回学，回写会话动作）。
    const attentionRoute = runAttentionStage({
      messages: sanitizedMessages,
      blocks: initialClassified.blocks,
      input,
      router: this.contextAttentionRouter,
      sessions: this.contextAttentionSessions,
    })

    // stage ③：保留上下文注入。
    const providerVisibleMessages = withProviderVisibleRetainedContext(
      attentionRoute?.messages ?? sanitizedMessages,
      initialClassified.blocks
    )

    // stage ①（末处）：注意力/保留重排后可能再引孤儿，最终校验前静默自愈一次。
    const providerMessages = applyHistoryStructureRepair(providerVisibleMessages.messages, {
      log: false,
    })
    const historyRewriteFingerprint = buildProviderHistoryRewriteFingerprint([
      ...(input.historyRewriteSignals ?? []),
      ...buildToolResultRewriteSignals(toolResultDedupe.ledger),
      ...buildRetainedContextRewriteSignals(providerVisibleMessages),
      ...buildAttentionRewriteSignals(attentionRoute, sanitizedMessages),
    ])
    assertValidModelHistory(providerMessages, { phase: 'compile', turn: null })

    // Ring 0 出核地板：指纹（共享扫描）+ 不变量校验，出核前必过。
    const requestFingerprint = buildProviderRequestFingerprint(
      input,
      providerMessages,
      resolveSharedToolReferenceScan(scratch, providerMessages)
    )
    assertProviderRequestInvariants(input, requestFingerprint, 'compile')

    // 工作集分类单遍（classify 是喂 ②③⑥ 的隐形第七 stage，收敛复用而非盲跑两遍）：
    // classify 是「消息序列 + 系统提示 + 工具面 + 注入上下文」的纯函数。当治理管线未真正改写消息
    // （路由未折叠任一消息 && 无保留上下文注入 && 末处结构自愈无改动）时，providerMessages 与
    // sanitizedMessages 逐字节相同，第二次 classify 必然产出与 initialClassified 逐字节相同的块，
    // 直接复用首遍结果。只有消息真被改写（折叠/摘要/保留注入/自愈）时才需第二次 classify 以让
    // 预算账本对齐改写后的块正文。attentionRoute 为 null（router off）沿用原有复用行为。
    const providerMessagesUnchanged =
      !!attentionRoute &&
      attentionRoute.messages === sanitizedMessages &&
      !providerVisibleMessages.retainedMessage &&
      providerMessages === providerVisibleMessages.messages
    const classified =
      !attentionRoute || providerMessagesUnchanged
        ? initialClassified
        : this.workingSetOS.classify({
            systemPrompt: input.systemPrompt,
            messages: providerMessages,
            toolSchemaChars: input.toolSchemaChars,
            retrievalHandles: input.retrievalHandles,
            activeTask: input.activeTask,
            pinnedEvidence: input.pinnedEvidence,
            resourceState: input.resourceState,
          })

    // stage ⑥：budget 钳制（估算 + 账本 + 分配 + 决策）。
    const budget = runBudgetStage({
      input,
      providerMessages,
      classifiedBlocks: classified.blocks,
      attentionRoute,
      dedupeLedger: toolResultDedupe.ledger,
    })

    return {
      system: input.systemPrompt,
      messages: providerMessages,
      ledger: budget.ledger,
      estimate: budget.estimate,
      decision: budget.decision,
      requestFingerprint,
      attentionTrace: attentionRoute?.trace,
      attentionReplayRecord: attentionRoute?.replayRecord,
      historyRewriteFingerprint,
    }
  }
}
