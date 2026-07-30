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
import { isEmpty, isTrue, toNullable } from '@velaros-ai/core'

import { compareStableStrings } from '../../agent/context/residency/determinism'
import type {
  CapabilitySpan,
  ExecutionSpan,
  ExecutionSpanStatus,
  ModelSpan,
  ToolSpan,
} from '../../protocol'

import { buildExecutionSpanTree } from './execution-span-tree'
import type { PromptAuditRecord } from './prompt-audit'

/** 一条 tool span 的调试投影（结构化错误码 / 分类 / 延迟）。 */
export interface ExecutionSpanDebugTool {
  toolCallId: string
  toolName: string
  toolCategoryId: Nullable<string>
  status: ExecutionSpanStatus
  errorCode: Nullable<string>
  latencyMs: Nullable<number>
}

/** 一条宿主注入能力 span 的调试投影；metadata 对 Kernel 保持不透明。 */
export interface ExecutionSpanDebugCapability {
  capabilityId: string
  operationId: string
  metadata: Readonly<Record<string, unknown>>
  latencyMs: Nullable<number>
}

/** 一条 policy span 的调试投影（收编 control-plane 决策）。 */
export interface ExecutionSpanDebugPolicy {
  source: string
  action: string
  reason: string
}

/**
 * 逐轮执行观测投影，与 get_debug turns 形状字段对齐（turn/role/model 同名同义），另附 span 独有的
 * 执行指标（token/cost/finishReason/指纹/延迟）。full=false 略去 tools/capabilities/policy 明细。
 */
export interface ExecutionSpanDebugTurn {
  /**
   * 所属 run 的 id——令摊平后的逐轮记录可归属回 run（区分父/子 Agent run，#37 阶段 C 片 2）。
   * span 契约的 runId 已放宽 nullable（会话级非 run 记录），故投影如实带 Nullable；turn 行恒有真实 runId。
   */
  runId: Nullable<string>
  /** 与 legacy turn 对齐：轮序号。 */
  turn: Nullable<number>
  /** 与 legacy turn 对齐：角色 id（span 无 roleLabel，故只投 roleId 口径）。 */
  role: Nullable<string>
  /** 与 legacy turn 对齐：模型 id（span 为字符串口径，legacy 为 roleRuntimeModel 对象）。 */
  model: Nullable<string>
  provider: Nullable<string>
  status: ExecutionSpanStatus
  latencyMs: Nullable<number>
  tokensIn: Nullable<number>
  tokensOut: Nullable<number>
  costUsd: Nullable<number>
  finishReason: Nullable<string>
  requestFingerprint: Nullable<string>
  toolCount: number
  toolErrorCount: number
  /** full-only：本轮工具 span 明细。 */
  tools?: ExecutionSpanDebugTool[]
  /** full-only：本轮宿主注入能力 span 明细。 */
  capabilities?: ExecutionSpanDebugCapability[]
  /** full-only：本轮控制/审批 span 明细。 */
  policy?: ExecutionSpanDebugPolicy[]
  /**
   * full-only：D3 prompt 审计侧信道带出的本回合重内容（系统提示词全文/promptSegments/capabilityContextAudit），
   * 靠 requestFingerprint 关联匹配。sidecar 缺失或指纹不匹配时缺席（fallback 语义）。
   */
  promptAudit?: ExecutionSpanDebugPromptAudit
}

/** D3 prompt 审计投影（full-only；内容态原样带出，脱敏见 prompt-audit.ts 裁决点）。 */
export interface ExecutionSpanDebugPromptAudit {
  systemPromptChars: number
  systemPrompt: string
  promptSegments: readonly unknown[]
  skippedPromptSegments: readonly unknown[]
  capabilityContextAudit: readonly unknown[]
}

/** 一次 run 的调试投影（按 runId 分组，与 §2.3「一会话多次 run 追加同文件」对齐）。 */
export interface ExecutionSpanDebugRun {
  /** run 的 id；span 契约放宽 nullable 后投影如实带 Nullable，run 行恒有真实 runId。 */
  runId: Nullable<string>
  status: ExecutionSpanStatus
  startedAt: number
  endedAt: number
  latencyMs: Nullable<number>
  turnCount: number
  /** 子 Agent 身份/角色名（主 Agent 根 run 用 null）——区分同会话内父/子 run 树（#37 阶段 C 片 2）。 */
  agentName: Nullable<string>
  /** 派发来源（子 Agent 的父角色；主 Agent 根 run 用 null）。 */
  dispatchSource: Nullable<string>
}

/** 执行 span 调试投影：run 分组 + 摊平后的逐轮记录（供 turns 对齐消费）。 */
export interface ExecutionSpanDebugProjection {
  runCount: number
  turnCount: number
  runs: ExecutionSpanDebugRun[]
  /** 跨 run 摊平的逐轮观测，按 startedAt 升序；调用方可 slice(-limit) 取尾窗。 */
  turns: ExecutionSpanDebugTurn[]
  /** 不隶属具体 run 的宿主能力观测，按 at 升序。 */
  capabilityObservations: Array<ExecutionSpanDebugCapability & { at: number }>
}

interface ProjectExecutionSpanDebugOptions {
  /** full=true 附带 tools/capabilities/policy 明细 + D3 prompt 审计；否则只投逐轮指标摘要。 */
  full?: boolean
  /** 仅保留最近 limit 轮（对齐 legacy turns.slice(-limit)）；缺省全保留。 */
  limit?: number
  /**
   * D3：本会话 prompt 审计侧信道记录（full 档按 requestFingerprint 关联挂到逐轮投影）。
   * 缺省/空 = 不带 prompt 审计（sidecar 缺失的 fallback）。
   */
  promptAudit?: readonly PromptAuditRecord[]
}

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
        span.category === 'capability' && span.parentSpanId === null
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
 * span 排序的唯一谓词：开始时刻升序，**同刻按 spanId 码元序**。
 *
 * 平手键不是装饰：同一毫秒内开出的 span 很常见（一轮里 model/tool span 连开），没有平手键时
 * `Array#sort` 的相对序由输入顺序决定，同一份账本在两台机器上能投出不同的 turns 顺序，
 * 而这份投影正是 get_debug / agent-lab 的对账输入。用码元序（`compareStableStrings` 单源）而非
 * `localeCompare`，理由同 determinism 模块：后者随 ICU 数据与 locale 变化。
 */
function compareSpansChronologically(left: ExecutionSpan, right: ExecutionSpan): number {
  if (left.startedAt !== right.startedAt) return left.startedAt - right.startedAt
  return compareStableStrings(left.spanId, right.spanId)
}
