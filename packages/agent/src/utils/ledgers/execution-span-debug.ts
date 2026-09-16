// 域：执行 span 树 → get_debug 观测面的投影适配（宪章 §11 span 模型的读侧消费面之一）。
//
// get_debug 的「执行观测段」终局改读执行旁账本（span 树）而非 renderer 侧的 `session.turnContexts`
// 环形缓冲（#37 阶段 C）。本文件是**纯投影**：把一串已完成 span 装配成执行树，再摊平成与 get_debug
// 现有 turns 形状**字段对齐**的逐轮记录（run→turn→{model,tool,capability,policy}），供 hook / agent-lab
// 装配层零改消费。
//
// **只投指标/结构，不投转录**（§2.2 交叉引用不合并）：span 账本刻意不复制 provider 转录（messages /
// systemPrompt / promptSegments 那些内容态属会话账本 + D3 prompt 审计侧信道，非本账本）。故本投影里
// 与转录相关的 legacy 字段（rawRequest/rawResponse/systemPromptChars 等）不出现，出现的都是 span
// 能确证的执行事实：token/cost/finishReason/指纹/工具分类与错误码/延迟。调用方据此把它与 legacy 转录
// 段并列（片 1 加数据源标注双源核对），完整替换随 D3 prompt 审计侧信道落地（片 2+）。
import { isEmpty, isNull, isTrue, toNullable } from '@velaros-ai/core'

import type { CapabilitySpan, ExecutionSpan, ModelSpan, ToolSpan } from '../../types/agent.js'
import type { ExecutionSpanDebugProjection, ExecutionSpanDebugRun, ExecutionSpanDebugTurn, ProjectExecutionSpanDebugOptions,PromptAuditRecord } from '../../types/ledgers.js'
import { compareStableStrings } from '../residency/determinism'

import { buildExecutionSpanTree } from './execution-span-tree'

/** 从 span 序列投影出 get_debug 执行观测段（纯函数，无 IO）。 */
export function projectExecutionSpanDebug(
  spans: readonly ExecutionSpan[],
  options: ProjectExecutionSpanDebugOptions = {}
): ExecutionSpanDebugProjection {
  const full = isTrue(options.full)
  const tree = buildExecutionSpanTree(spans)
  const childSpans = (spanId: string): ExecutionSpan[] =>
    (tree.nodesById[spanId]?.childIds ?? []).map((id) => tree.nodesById[id].span)

  // D3：full 档按 requestFingerprint 建 prompt 审计索引（同指纹取最后写入的记录）。
  const promptAuditByFingerprint = full ? indexPromptAudit(options.promptAudit) : null

  // turn span 是执行观测的逐轮锚：其父可能是 run span，也可能因活读父未落盘而成孤儿——两者都投。
  const turnSpans = spans
    .filter((span): span is Extract<ExecutionSpan, { category: 'turn' }> => span.category === 'turn')
    .sort(compareSpansChronologically)

  const turns: ExecutionSpanDebugTurn[] = turnSpans.map((turnSpan) =>
    projectTurn(turnSpan, childSpans(turnSpan.spanId), full, promptAuditByFingerprint)
  )

  const capabilityObservations = spans
    .filter(
      (span): span is CapabilitySpan =>
        span.category === 'capability' && isNull(span.parentSpanId)
    )
    .sort(compareSpansChronologically)
    .map((span) => ({
      capabilityId: span.capabilityId,
      operationId: span.operationId,
      metadata: span.metadata,
      latencyMs: span.metrics.latencyMs,
      at: span.startedAt,
    }))

  const runs = spans
    .filter((span): span is Extract<ExecutionSpan, { category: 'run' }> => span.category === 'run')
    .sort(compareSpansChronologically)
    .map(
      (runSpan): ExecutionSpanDebugRun => ({
        runId: runSpan.runId,
        status: runSpan.status,
        startedAt: runSpan.startedAt,
        endedAt: runSpan.endedAt,
        latencyMs: runSpan.metrics.latencyMs,
        turnCount: turnSpans.filter((turnSpan) => turnSpan.runId === runSpan.runId).length,
        agentName: runSpan.agentName,
        dispatchSource: runSpan.dispatchSource,
      })
    )

  const limitedTurns =
    options.limit && options.limit > 0 ? turns.slice(-options.limit) : turns

  return {
    runCount: runs.length,
    turnCount: turns.length,
    runs,
    turns: limitedTurns,
    capabilityObservations,
  }
}

/** D3：按 requestFingerprint 索引 prompt 审计记录（同指纹后写覆盖前写，取最新）。 */
function indexPromptAudit(
  records: LooseOptional<readonly PromptAuditRecord[]>
): Nullable<Map<string, PromptAuditRecord>> {
  if (!records || isEmpty(records)) return null
  const byFingerprint = new Map<string, PromptAuditRecord>()
  for (const record of records) {
    if (record.requestFingerprint) byFingerprint.set(record.requestFingerprint, record)
  }
  return byFingerprint.size > 0 ? byFingerprint : null
}

function projectTurn(
  turnSpan: Extract<ExecutionSpan, { category: 'turn' }>,
  children: ExecutionSpan[],
  full: boolean,
  promptAuditByFingerprint: Nullable<Map<string, PromptAuditRecord>>
): ExecutionSpanDebugTurn {
  const modelSpan = pickModelSpan(children)
  const toolSpans = children.filter((span): span is ToolSpan => span.category === 'tool')
  const capabilitySpans = children.filter(
    (span): span is CapabilitySpan => span.category === 'capability'
  )
  const policySpans = children.filter(
    (span): span is Extract<ExecutionSpan, { category: 'policy' }> => span.category === 'policy'
  )

  const projection: ExecutionSpanDebugTurn = {
    runId: turnSpan.runId,
    turn: turnSpan.turn,
    role: turnSpan.roleId,
    model: modelSpan?.model ?? turnSpan.model,
    provider: toNullable(modelSpan?.provider),
    status: turnSpan.status,
    latencyMs: modelSpan?.metrics.latencyMs ?? turnSpan.metrics.latencyMs,
    tokensIn: toNullable(modelSpan?.metrics.tokensIn),
    tokensOut: toNullable(modelSpan?.metrics.tokensOut),
    costUsd: toNullable(modelSpan?.metrics.costUsd),
    finishReason: toNullable(modelSpan?.finishReason),
    requestFingerprint: toNullable(modelSpan?.requestFingerprint),
    toolCount: toolSpans.length,
    toolErrorCount: toolSpans.filter((span) => span.status === 'error').length,
  }
  if (!full) return projection

  projection.tools = toolSpans.map((span) => ({
    toolCallId: span.toolCallId,
    toolName: span.toolName,
    toolCategoryId: span.toolCategoryId,
    toolEffectKind: toNullable(span.toolEffectKind),
    status: span.status,
    errorCode: span.errorCode,
    latencyMs: span.metrics.latencyMs,
  }))
  projection.capabilities = capabilitySpans.map((span) => ({
    capabilityId: span.capabilityId,
    operationId: span.operationId,
    metadata: span.metadata,
    latencyMs: span.metrics.latencyMs,
  }))
  projection.policy = policySpans.map((span) => ({
    source: span.source,
    action: span.action,
    reason: span.reason,
  }))
  // D3：按 requestFingerprint 关联本回合的 prompt 审计重内容（sidecar 缺失/指纹不匹配则缺席）。
  const fingerprint = projection.requestFingerprint
  const audit = fingerprint ? promptAuditByFingerprint?.get(fingerprint) : null
  if (audit) {
    projection.promptAudit = {
      systemPromptChars: audit.systemPrompt.length,
      systemPrompt: audit.systemPrompt,
      promptSegments: audit.promptSegments,
      skippedPromptSegments: audit.skippedPromptSegments,
      capabilityContextAudit: audit.capabilityContextAudit,
      providerRequest: audit.providerRequest,
    }
  }
  return projection
}

/** 一轮一个 model span（SoloLoop 每轮 turn-start 开一条）；防御性取最后开启的那条。 */
function pickModelSpan(children: readonly ExecutionSpan[]): Nullable<ModelSpan> {
  const modelSpans = children.filter((span): span is ModelSpan => span.category === 'model')
  if (isEmpty(modelSpans)) return null
  return modelSpans.reduce((latest, span) =>
    span.startedAt >= latest.startedAt ? span : latest
  )
}

/**
 * 执行区段排序的唯一谓词：开始时刻升序，**同刻按 `spanId` 码元序**。
 *
 * 平手键不是装饰：同一毫秒内开启多个区段很常见，例如一轮里连续开启模型与工具区段。没有
 * 平手键时，`Array#sort` 的相对顺序由输入决定，同一份账本在两台机器上可能投出不同的回合顺序，
 * 而这份投影正是 `get_debug` 与 `agent-lab` 的对账输入。这里使用 `compareStableStrings` 提供的
 * 码元序，不使用 `localeCompare`；后者会随 `ICU` 数据和地区设置变化。
 */
function compareSpansChronologically(left: ExecutionSpan, right: ExecutionSpan): number {
  if (left.startedAt !== right.startedAt) return left.startedAt - right.startedAt
  return compareStableStrings(left.spanId, right.spanId)
}
