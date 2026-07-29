import { createHash } from 'node:crypto'

import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isNull, isNumber,isRecord, Log, toOptional } from '@velaros-ai/core'
import type { ChatContextDebugTraceEntry } from '@velaros-ai/core/types'

import { readVerbatimString } from './providerRequest/messageScan'
import {
  ContextAttentionActionOptimizer,
  type ContextAttentionRouteOptimization,
} from './ContextAttentionActionOptimizer'
import { buildStructuredExcerpt } from './ContextAttentionExcerpt'
import type { ContextAttentionBlockOutcome } from './ContextAttentionOutcomeRecorder'
import {
  buildContextAttentionQueryAnalysis,
  type ContextAttentionDecision,
  ContextAttentionInlineExcerptChars,
  ContextAttentionPolicyEngine,
  type ContextAttentionRouterMode,
  readContextAttentionMessageIndex,
  readContextAttentionMessageText,
} from './ContextAttentionPolicyEngine'
import type { ContextAttentionReplayRecord } from './ContextAttentionReplayRecorder'
import {
  type ContextAttentionRouteValidation,
  ContextAttentionRouteValidator,
  type ContextAttentionRouteViolation,
} from './ContextAttentionRouteValidator'
import {
  type ContextCodePruningTrace,
  ContextCodeSnippetPruner,
} from './ContextCodeSnippetPruner'
import type { ContextEvidenceGraph } from './ContextEvidenceGraph'
import type { ContextLedgerEntry,ContextWorkingSetBlock } from './ContextLedger'
import { buildContextRefEnvelope, isFoldStubText } from './contextRefEnvelope'

const log = Log.tag('ContextAttentionRouter')

interface ContextAttentionMessagePlan {
  messageIndex: number
  blockId: string
  action: ChatContextDebugTraceEntry['action']
  reason: string
  query: string
  codePruning?: ContextCodePruningTrace
}

export interface ContextAttentionRouterInput {
  messages: ModelMessage[]
  blocks: ContextWorkingSetBlock[]
  mode?: ContextAttentionRouterMode
  budgetTokens?: LooseOptional<number>
  evidenceGraph?: LooseOptional<ContextEvidenceGraph>
  queryEmbedding?: LooseOptional<readonly number[]>
  /** 上一次已应用路由的降级动作，用于跨回合粘滞：已折叠的块保持折叠，稳定提供方前缀缓存。 */
  previousActionsByBlockId?: LooseOptional<ReadonlyMap<string, ChatContextDebugTraceEntry['action']>>
  /** recall_context 回学信号：反复召回或召回失败的块不再降级。 */
  blockOutcomes?: LooseOptional<ReadonlyMap<string, ContextAttentionBlockOutcome>>
}

export interface ContextAttentionRouterResult {
  messages: ModelMessage[]
  trace: ChatContextDebugTraceEntry[]
  ledgerActionsByBlockId: Map<string, { action: ContextLedgerEntry['action']; reason: string }>
  replayRecord: ContextAttentionReplayRecord
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function resolveLatestUserIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }

  return messages.length - 1
}

function resolveQuery(messages: readonly ModelMessage[], latestUserIndex: number): string {
  return readContextAttentionMessageText(messages[latestUserIndex])
}

function readCodePruningInput(message?: ModelMessage): Nullable<{
  text: string
  toolCallId?: string
  toolName?: string
}> {
  if (!message) return null

  if (message.role !== 'tool' || !isArray(message.content)) {
    const text = readContextAttentionMessageText(message)
    return text.trim() ? { text } : null
  }

  const textParts: string[] = []
  let toolCallId: Nullable<string> = null
  let toolName: Nullable<string> = null

  for (const part of message.content as unknown[]) {
    if (!isRecord(part) || part.type !== 'tool-result') continue
    const output = part.output
    if (!isRecord(output)) continue

    const value = readVerbatimString(output.value)
    if (!value) continue

    textParts.push(value)
    toolCallId ??= readVerbatimString(part.toolCallId)
    toolName ??= readVerbatimString(part.toolName)
  }

  const text = textParts.join('\n\n').trim()
  if (!text) return null

  return {
    text,
    toolCallId: toOptional(toolCallId),
    toolName: toOptional(toolName),
  }
}

function buildToolPayloadAttentionHandle(input: {
  blockId: string
  toolCallId: string
  toolName: string
  value: string
  reason: string
  codePruning?: ContextCodePruningTrace
}): string {
  // B2:统一信封。ref 必须保持 toolCallId(回学归因 recallSigByRef 按它映射到内容指纹,
  // 改成 ctx-payload:* 会让 recalled/missing 信号全部失联——红旗项)。
  const attentionRetrieval = {
    tool: 'recall_context' as const,
    args: {
      ref: input.toolCallId,
      refKind: 'tool-payload' as const,
      reason: 'need full historical tool result',
      maxChars: 8_000,
    },
  }

  if (input.codePruning?.recall && input.codePruning.selectedLines < input.codePruning.originalLines) {
    return JSON.stringify(
      buildContextRefEnvelope({
        __contextRef: 'attention-code-pruned-context-handle',
        ref: input.toolCallId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        payloadHash: shortHash(input.value),
        originalLength: input.value.length,
        reason: input.reason,
        excerpt: input.codePruning.prunedPreview,
        excerptKind: 'code',
        excerptTruncated: true,
        retrieval: attentionRetrieval,
        // 富元数据整体归 meta(kind 扩展字段),裁剪信息零丢失。
        meta: {
          blockId: input.blockId,
          codePruning: {
            strategy: input.codePruning.strategy,
            language: input.codePruning.language,
            filePaths: input.codePruning.filePaths,
            originalLines: input.codePruning.originalLines,
            selectedLines: input.codePruning.selectedLines,
            prunedLines: input.codePruning.prunedLines,
            selectedLineNumbers: input.codePruning.selectedLineNumbers,
            selectedRanges: input.codePruning.selectedRanges,
            reasons: input.codePruning.reasons,
            rubricScores: input.codePruning.rubricScores,
            editGuard: input.codePruning.editGuard,
            prunedPreview: input.codePruning.prunedPreview,
            confidence: input.codePruning.confidence,
            previewTruncated: input.codePruning.previewTruncated,
            parseDiagnostics: toOptional(input.codePruning.parseDiagnostics),
          },
        },
      })
    )
  }

  // 结构感知预览:保留全部顶层字段、只截断大嵌套值(取代盲砍前 N 字)。
  const structured = buildStructuredExcerpt(input.value)

  return JSON.stringify(
    buildContextRefEnvelope({
      __contextRef: 'attention-context-handle',
      ref: input.toolCallId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      payloadHash: shortHash(input.value),
      originalLength: input.value.length,
      excerpt: structured.excerpt,
      excerptKind: structured.kind,
      excerptTruncated: structured.truncated,
      reason: input.reason,
      // retrieval 恒存在恒同形(统一解析);未截断时靠 excerptTruncated:false +
      // recall_context 的 forbidden 口径压制空转召回(红旗项,需观测 recall outcome)。
      retrieval: attentionRetrieval,
      meta: { blockId: input.blockId },
    })
  )
}

function rewriteToolMessageWithHandle(
  message: ModelMessage,
  plan: ContextAttentionMessagePlan
): ModelMessage {
  if (message.role !== 'tool' || !isArray(message.content)) return message

  let changed = false
  const content = (message.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== 'tool-result') return part
    const output = part.output
    if (!isRecord(output)) return part

    const toolCallId = readVerbatimString(part.toolCallId)
    const toolName = readVerbatimString(part.toolName)
    const outputType = output.type
    const value = readVerbatimString(output.value)
    if (!toolCallId || !toolName || !value) return part
    if (outputType !== 'text' && outputType !== 'error-text') return part
    // 统一嗅探(B1,修真实缺陷):旧判定只认 __contextRef,会把 __kernelRef/__truncated 桩
    // 再包一层 attention-handle(双重折叠,模型要剥两层皮才知道去召回什么)。
    if (isFoldStubText(value)) return part

    changed = true
    return {
      ...part,
      output: {
        ...output,
        value: buildToolPayloadAttentionHandle({
          blockId: plan.blockId,
          toolCallId,
          toolName,
          value,
          reason: plan.reason,
          codePruning: plan.codePruning,
        }),
      },
    }
  })

  if (!changed) return message

  return {
    ...message,
    content: content as ModelMessage['content'],
  } as ModelMessage
}

function summarizeText(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (compact.length <= ContextAttentionInlineExcerptChars) return compact
  return `${compact.slice(0, ContextAttentionInlineExcerptChars)}...`
}

function summaryTerms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}_./:-]{3,}/gu) ?? [])
        .flatMap((term) => term.split(/[./:-]/u).concat(term))
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
    ),
  ]
}

function buildGroundedFacts(text: string, query: string): Array<{ sourceLine: number; text: string }> {
  const terms = summaryTerms(query)
  const lines = text.split(/\r?\n/u)
  const facts = lines
    .map((line, index) => ({ sourceLine: index + 1, text: line.replace(/\s+/gu, ' ').trim() }))
    .filter((line) => line.text)
  const termFacts = isEmpty(terms)
    ? []
    : facts.filter((line) => {
        const lower = line.text.toLowerCase()
        return terms.some((term) => lower.includes(term))
      })
  const selected = (isEmpty(termFacts) ? facts : termFacts).slice(0, 5)

  return selected.map((fact) => ({
    sourceLine: fact.sourceLine,
    text: fact.text.slice(0, 360),
  }))
}

function rewriteLongMessageWithSummary(
  message: ModelMessage,
  plan: ContextAttentionMessagePlan
): ModelMessage {
  if (message.role === 'tool') return message
  const text = readContextAttentionMessageText(message)

  return {
    ...message,
    // B3:判别键统一为 __contextRef(旧键 __contextSummary 由 isFoldStubText 永久兼容识别);
    // ref 保持 blockId(回学归因 recallSigByRef 依赖它映射到内容指纹,红旗项)。
    content: JSON.stringify(
      buildContextRefEnvelope({
        __contextRef: 'attention-grounded-summary',
        ref: plan.blockId,
        reason: plan.reason,
        excerpt: summarizeText(text),
        excerptKind: 'facts',
        excerptTruncated: text.length > ContextAttentionInlineExcerptChars,
        originalLength: text.length,
        retrieval: {
          tool: 'recall_context',
          args: {
            ref: plan.blockId,
            refKind: 'context-handle',
            reason: 'need full summarized conversation turn',
            maxChars: 8_000,
          },
        },
        meta: {
          blockId: plan.blockId,
          source: { messageIndex: plan.messageIndex, role: message.role },
          facts: buildGroundedFacts(text, plan.query),
        },
      })
    ),
  } as ModelMessage
}

function applyPlans(
  messages: ModelMessage[],
  decisions: readonly ContextAttentionDecision[],
  codePruningByBlockId: ReadonlyMap<string, ContextCodePruningTrace>,
  query: string
): ModelMessage[] {
  const plans: ContextAttentionMessagePlan[] = []
  decisions.forEach((decision) => {
    if (isNull(decision.messageIndex)) return
    plans.push({
      messageIndex: decision.messageIndex,
      blockId: decision.blockId,
      action: decision.action,
      reason: decision.reason,
      query,
      codePruning: toOptional(codePruningByBlockId.get(decision.blockId)),
    })
  })

  if (isEmpty(plans)) return messages

  const plansByMessage = new Map(plans.map((plan) => [plan.messageIndex, plan]))
  let changed = false
  const nextMessages = messages.map((message, index) => {
    const plan = plansByMessage.get(index)
    if (!plan) return message

    const nextMessage =
      plan.action === 'handle'
        ? rewriteToolMessageWithHandle(message, plan)
        : plan.action === 'summarize'
          ? rewriteLongMessageWithSummary(message, plan)
          : message

    if (nextMessage !== message) changed = true
    return nextMessage
  })

  return changed ? nextMessages : messages
}

const StickyDowngradeActions = new Set<ChatContextDebugTraceEntry['action']>([
  'handle',
  'summarize',
])

/**
 * 跨回合粘滞：上一轮已应用的降级在本轮策略想恢复 inline 时保持降级。
 *
 * 目的不是省 token 而是稳定前缀缓存——已折叠块每回翻回原文都会把提供方缓存
 * 从该消息起打断。只有块重新变得重要（显式提及/失败证据/有状态结果/硬保留）才解除粘滞。
 */
function applyStickyDowngrades(
  decisions: readonly ContextAttentionDecision[],
  messages: readonly ModelMessage[],
  previousActionsByBlockId: LooseOptional<ReadonlyMap<string, ChatContextDebugTraceEntry['action']>>
): ContextAttentionDecision[] {
  if (!previousActionsByBlockId || previousActionsByBlockId.size === 0) return [...decisions]

  return decisions.map((decision) => {
    const previousAction = previousActionsByBlockId.get(decision.blockId)
    if (!previousAction || !StickyDowngradeActions.has(previousAction)) return decision
    if (decision.action !== 'inline' && decision.action !== 'retain') return decision
    if (decision.hardRetained || isNull(decision.messageIndex)) return decision
    if (
      decision.features.explicitlyMentioned ||
      decision.features.toolFailureReason ||
      decision.features.statefulToolResult ||
      decision.features.currentTaskEvidence
    ) return decision

    const message = messages[decision.messageIndex]
    if (previousAction === 'handle') {
      if (message?.role !== 'tool' || !decision.features.recoverable) return decision
      return {
        ...decision,
        action: 'handle',
        ledgerAction: 'reference',
        reason: `sticky downgrade keeps previously handled payload folded for prefix cache stability; ${decision.reason}`,
      }
    }

    if (message?.role === 'tool') return decision
    return {
      ...decision,
      action: 'summarize',
      ledgerAction: 'summary',
      reason: `sticky downgrade keeps previously summarized turn folded for prefix cache stability; ${decision.reason}`,
    }
  })
}

/** 模型对同一折叠块的召回达到该次数即视为折叠抖动，回学为常驻 inline。 */
const RecallThrashThreshold = 2

/**
 * 结果信号回学：把 recall_context 的实际使用反馈应用到本轮决策。
 *
 * - 召回失败（missing-context）：折叠被证明不可恢复，该块永不再降级；
 * - 反复召回（≥{@link RecallThrashThreshold} 次）：模型持续需要这块内容，
 *   继续折叠只会制造"召回→再折叠→再召回"的抖动循环，提升为 inline 打断它。
 *
 * 单次召回不改变路由——召回结果本身已作为新工具消息进入历史，旧块保持折叠反而省 token。
 */
function applyOutcomeProtections(
  decisions: readonly ContextAttentionDecision[],
  blockOutcomes: LooseOptional<ReadonlyMap<string, ContextAttentionBlockOutcome>>
): ContextAttentionDecision[] {
  if (!blockOutcomes || blockOutcomes.size === 0) return [...decisions]

  return decisions.map((decision) => {
    if (decision.action !== 'handle' && decision.action !== 'summarize' && decision.action !== 'drop') return decision

    const outcome = blockOutcomes.get(decision.blockId)
    if (!outcome) return decision

    if (outcome.missingContextCount > 0) return {
        ...decision,
        action: 'inline',
        ledgerAction: 'inline',
        reason: `outcome learning keeps block inline: previous recall of this block failed (${outcome.missingContextCount}x missing-context); ${decision.reason}`,
      }

    if (outcome.recallCount >= RecallThrashThreshold) return {
        ...decision,
        action: 'inline',
        ledgerAction: 'inline',
        reason: `outcome learning keeps block inline: model recalled this block ${outcome.recallCount}x, folding it again causes recall thrash; ${decision.reason}`,
      }

    return decision
  })
}

function toTraceEntry(
  decision: ContextAttentionDecision,
  optimization: ContextAttentionRouteOptimization,
  validation: ContextAttentionRouteValidation,
  evidenceGraph?: LooseOptional<ContextEvidenceGraph>,
  codePruning?: ContextCodePruningTrace
): ChatContextDebugTraceEntry {
  const evidence = evidenceGraph?.nodesByBlockId.get(decision.blockId)

  return {
    stage: 'context-attention',
    action: decision.action,
    target: decision.blockId,
    reason: decision.reason,
    score: decision.score,
    metadata: {
      zone: decision.zone,
      chars: decision.chars,
      messageIndex: decision.messageIndex,
      hardRetained: decision.hardRetained,
      phases: ['contracts', 'shadow', 'diff', 'guarded-selection'],
      features: decision.features,
      routingScores: decision.routingScores,
      scoreBreakdown: decision.breakdown,
      actionCandidates: decision.actionCandidates ?? [],
      routeOptimization: optimization,
      routeValidation: validation,
      evidence: toOptional(evidence),
      codePruning: toOptional(codePruning),
    },
  }
}

function sanitizeReplayMetadata(
  metadata: LooseOptional<Record<string, unknown>>
): Record<string, unknown> | undefined {
  if (!metadata) return undefined

  const { codePruning, ...rest } = metadata
  const safeMetadata: Record<string, unknown> = { ...rest }
  if (isRecord(codePruning)) {
    const { prunedPreview: _prunedPreview, ...safeCodePruning } = codePruning
    safeMetadata.codePruning = safeCodePruning
  }

  return safeMetadata
}

function buildReplayRecord(input: {
  trace: readonly ChatContextDebugTraceEntry[]
  mode: ContextAttentionRouterMode
  budgetTokens: Nullable<number>
}): ContextAttentionReplayRecord {
  const seed = JSON.stringify({
    mode: input.mode,
    budgetTokens: input.budgetTokens,
    trace: input.trace.map((entry) => [entry.target, entry.action, entry.score]),
  })

  return {
    schemaVersion: 1,
    routeId: `ctx-attn:${shortHash(`${Date.now()}:${seed}`)}`,
    timestamp: Date.now(),
    mode: input.mode,
    budgetTokens: input.budgetTokens,
    decisions: input.trace.map((entry) => ({
      blockId: entry.target,
      action: entry.action,
      score: toOptional(entry.score),
      reason: entry.reason,
      metadata: sanitizeReplayMetadata(entry.metadata),
    })),
  }
}

export class ContextAttentionRouter {
  private readonly policyEngine = new ContextAttentionPolicyEngine()
  private readonly actionOptimizer = new ContextAttentionActionOptimizer()
  private readonly routeValidator = new ContextAttentionRouteValidator()
  private readonly codeSnippetPruner = new ContextCodeSnippetPruner()

  public route(input: ContextAttentionRouterInput): ContextAttentionRouterResult {
    try {
      return this.routeInternal(input)
    } catch (error) {
      log.warn('context attention router failed; falling back to original provider messages', {
        error: String(error),
      })
      return buildExceptionFallbackRoute(input, error)
    }
  }

  private routeInternal(input: ContextAttentionRouterInput): ContextAttentionRouterResult {
    const mode = input.mode ?? 'active'
    const latestUserIndex = resolveLatestUserIndex(input.messages)
    const query = resolveQuery(input.messages, latestUserIndex)
    // 查询侧词表单遍：query 在整轮路由内恒定，五套 query-only 词表算一次，N 个 block 复用。
    const queryAnalysis = buildContextAttentionQueryAnalysis(query)
    const decisions = input.blocks.map((block) => {
      const messageIndex = readContextAttentionMessageIndex(block.id)
      const message = isNull(messageIndex) ? undefined : input.messages[messageIndex]
      return this.policyEngine.decide({
        block,
        message,
        messageIndex,
        latestUserIndex,
        query,
        queryAnalysis,
        messageCount: input.messages.length,
        evidenceGraph: input.evidenceGraph,
        queryEmbedding: input.queryEmbedding,
      })
    })
    const stickyDecisions = applyStickyDowngrades(
      decisions,
      input.messages,
      input.previousActionsByBlockId
    )
    const optimized = this.actionOptimizer.optimize({
      decisions: stickyDecisions,
      mode,
      budgetTokens: input.budgetTokens,
    })
    const finalDecisions = applyOutcomeProtections(optimized.decisions, input.blockOutcomes)
    const validation = this.routeValidator.validate({
      decisions: finalDecisions,
    })
    const routeValidation: ContextAttentionRouteValidation = validation.passed
      ? validation
      : {
          ...validation,
          fallbackApplied: true,
        }
    const codePruningByBlockId = new Map<string, ContextCodePruningTrace>()

    // 代码裁剪（含 TS AST 解析）只对 action==='handle' 的 decision 跑：codePruning 的产物只被
    // handle 的消息改写（rewriteToolMessageWithHandle→buildToolPayloadAttentionHandle）消费——
    // summarize 的改写（rewriteLongMessageWithSummary）不读它，inline/retain/skip/drop 不改写消息。
    // 旧实现对每个消息 decision 都跑 AST（含 inline/retain/summarize），产物对非 handle 只进
    // 调试 trace.metadata.codePruning（非契约字段）。契约字段（messages/ledger/decision/指纹）
    // 逐字节不变；非 handle 的 trace codePruning 元数据不再产出（调试面，非发送内容）。
    finalDecisions.forEach((decision) => {
      if (decision.action !== 'handle') return
      if (isNull(decision.messageIndex)) return

      const pruningInput = readCodePruningInput(input.messages[decision.messageIndex])
      if (!pruningInput) return

      const codePruning = this.codeSnippetPruner.analyze({
        blockId: decision.blockId,
        query,
        text: pruningInput.text,
        toolCallId: pruningInput.toolCallId,
        toolName: pruningInput.toolName,
      })
      if (codePruning) codePruningByBlockId.set(decision.blockId, codePruning)
    })
    const ledgerActionsByBlockId = new Map<
      string,
      { action: ContextLedgerEntry['action']; reason: string }
    >()

    const shouldApplyRouting = (mode === 'guarded' || mode === 'active') && validation.passed

    if (shouldApplyRouting) {
      finalDecisions.forEach((decision) => {
        ledgerActionsByBlockId.set(decision.blockId, {
          action: decision.ledgerAction,
          reason: decision.reason,
        })
      })
    }

    const trace = finalDecisions.map((decision) =>
      toTraceEntry(
        decision,
        optimized.optimization,
        routeValidation,
        input.evidenceGraph,
        codePruningByBlockId.get(decision.blockId)
      )
    )

    return {
      messages: shouldApplyRouting
        ? applyPlans(input.messages, finalDecisions, codePruningByBlockId, query)
        : input.messages,
      trace,
      ledgerActionsByBlockId,
      replayRecord: buildReplayRecord({
        trace,
        mode,
        budgetTokens: isNumber(input.budgetTokens) ? Math.max(0, input.budgetTokens) : null,
      }),
    }
  }
}

function buildExceptionFallbackRoute(
  input: ContextAttentionRouterInput,
  error: unknown
): ContextAttentionRouterResult {
  const mode = input.mode ?? 'active'
  const violation: ContextAttentionRouteViolation = {
    severity: 'fatal',
    code: 'router-exception',
    blockId: 'context-attention-router',
    message: String(error),
  }
  const routeValidation: ContextAttentionRouteValidation = {
    passed: false,
    checked: ['router-exception-fallback'],
    violations: [violation],
    fatalViolations: [violation],
    warningViolations: [],
    fallbackRequired: true,
    fallbackApplied: true,
  }
  const trace: ChatContextDebugTraceEntry[] = [
    {
      stage: 'context-attention',
      action: 'retain',
      target: 'context-attention-router',
      reason: 'context attention router failed; original provider messages retained',
      score: 1,
      metadata: {
        routeValidation,
        error: String(error),
      },
    },
  ]

  return {
    messages: input.messages,
    trace,
    ledgerActionsByBlockId: new Map(),
    replayRecord: buildReplayRecord({
      trace,
      mode,
      budgetTokens: isNumber(input.budgetTokens) ? Math.max(0, input.budgetTokens) : null,
    }),
  }
}
