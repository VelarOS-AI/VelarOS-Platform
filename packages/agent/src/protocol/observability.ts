// 域：Agent 执行观测 span 数据契约；通用 Kernel event stream 不解释这些字段。
//
// span 模型是**与 `SessionEntrySchema` 并列的独立判别联合**——不是给会话树 entry 加变体（那会把高频、
// 可裁剪、非上下文权威的观测数据挤进会话树），而是执行账本（旁账本）的行契约。判别字段 `category`
// 贴 `SessionEntrySchema` 的 `type` 惯例，树形指针 `parentSpanId` 与会话树 `parentId` 同构。
//
// **开放追加，不开放修改**（宪章 §6）：新增观测类别 = 追加一个 span 变体，已发布变体字段在同 major
// 内不改。协议面一律 `z.strictObject`（§6 wire 裁决 ⑥：Forgiving 是模型输入边界的宽容，协议是版本化契约）。
import { z } from 'zod'

/** span 类别：通用执行面 model/tool/capability/policy + run/turn 两个结构容器。判别字段。 */
export const ExecutionSpanCategorySchema = z.enum([
  'run',
  'turn',
  'model',
  'tool',
  'capability',
  'policy',
])
export type ExecutionSpanCategory = z.infer<typeof ExecutionSpanCategorySchema>

/** span 收敛态：成功 / 出错 / 中止。只落已完成 span，故无 in-progress 态。 */
export const ExecutionSpanStatusSchema = z.enum(['ok', 'error', 'aborted'])
export type ExecutionSpanStatus = z.infer<typeof ExecutionSpanStatusSchema>

/**
 * span 度量四元组（宪章 §11「token/cost/latency 指标」）。
 *
 * 缺席一律用 null（宪章 §12.6 缺席值单一）——某类 span 天然无某项指标（如 tool span 无 token）时置 null，
 * 不省略字段（保形便于消费面无分支读取）。
 */
export const ExecutionSpanMetricsSchema = z.strictObject({
  latencyMs: z.number().nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  costUsd: z.number().nullable(),
})
export type ExecutionSpanMetrics = z.infer<typeof ExecutionSpanMetricsSchema>

/** 全 span 公共字段：身份 + 树形指针 + 时序 + 收敛态 + 度量。 */
const executionSpanBaseFields = {
  spanId: z.string(),
  /** 树形指针（宪章 §6 同构）；根 span（run）无父，用 Nullable 表达缺席。 */
  parentSpanId: z.string().nullable(),
  /**
   * 所属执行 run 的 id（同一次 agent 执行的全部 span 共享；账本按 runId 分组而非按文件切分）。
   *
   * **会话级记录无 run，用 null 表达缺席**（§12.6，贴 `parentSpanId` 口径）：注意力 outcome 回学镜像是只写
   * 会话级审计、不隶属某次 agent run，故其 runId 为 null，取代旧的伪 runId 魔法哨兵 `'attention-outcome'`。
   * run/turn/model/tool/policy span 恒有真实 runId。
   */
  runId: z.string().nullable(),
  sessionId: z.string(),
  /** 人读名（工具名 / 'provider-request' / 'context:recall' 等）。 */
  name: z.string(),
  startedAt: z.number().int(),
  /** 收敛时刻；只追加已完成 span，故落盘记录恒有值。 */
  endedAt: z.number().int(),
  status: ExecutionSpanStatusSchema,
  metrics: ExecutionSpanMetricsSchema,
}

/** run span：一次完整 agent 执行的根节点。 */
export const RunSpanSchema = z.strictObject({
  ...executionSpanBaseFields,
  category: z.literal('run'),
  /** 触发本次执行的输入 id（缺席用 null）。 */
  rootInputId: z.string().nullable(),
  /**
   * 子 Agent 可辨识标注：子 Agent 身份/角色名（主 Agent 根 run 用 null）。子 Agent 的执行是**独立顶层
   * run span**（新 runId、`parentSpanId:null`、落同一会话账本、靠 sessionId 与父关联，不嵌父 dispatch tool
   * span），本字段令其在同会话多 run 树里可辨识。宪章 §6 纯追加可选，主 major 内不改。
   */
  agentName: z.string().nullable(),
  /** 派发来源（子 Agent 由哪个父角色/派发链发起；主 Agent 根 run 用 null）。 */
  dispatchSource: z.string().nullable(),
})
export type RunSpan = z.infer<typeof RunSpanSchema>

/** turn span：run 内一次 provider 生成回合的结构容器（D5：usage 挂在此确定 turn 的 model 子 span 上）。 */
export const TurnSpanSchema = z.strictObject({
  ...executionSpanBaseFields,
  category: z.literal('turn'),
  turn: z.number().int(),
  roleId: z.string().nullable(),
  model: z.string().nullable(),
})
export type TurnSpan = z.infer<typeof TurnSpanSchema>

/** model span：一次 provider 请求/响应（承载 token/cost/latency 的主要来源）。 */
export const ModelSpanSchema = z.strictObject({
  ...executionSpanBaseFields,
  category: z.literal('model'),
  provider: z.string(),
  model: z.string(),
  /** Ring0 请求指纹（与 context-replays 对齐，便于跨账本关联）。 */
  requestFingerprint: z.string().nullable(),
  finishReason: z.string().nullable(),
})
export type ModelSpan = z.infer<typeof ModelSpanSchema>

/** tool span：一次工具调用（从执行三件套生命周期发出）。 */
export const ToolSpanSchema = z.strictObject({
  ...executionSpanBaseFields,
  category: z.literal('tool'),
  toolCallId: z.string(),
  toolName: z.string(),
  toolCategoryId: z.string().nullable(),
  /** 失败时的结构化错误码（成功用 null）。 */
  errorCode: z.string().nullable(),
})
export type ToolSpan = z.infer<typeof ToolSpanSchema>

/**
 * capability span：宿主注入能力的一次通用观测。
 *
 * Kernel 只保留能力身份、调用方定义的操作身份和不透明元数据，不解释产品领域语义。能力包/宿主负责
 * 定义 operationId 与 metadata 的含义。
 */
export const CapabilitySpanSchema = z.strictObject({
  ...executionSpanBaseFields,
  category: z.literal('capability'),
  capabilityId: z.string().min(1),
  operationId: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
})
export type CapabilitySpan = z.infer<typeof CapabilitySpanSchema>

/** policy span：一次控制面/审批决策（收编 control-plane ledger entry 的 source/action/reason 形状）。 */
export const PolicySpanSchema = z.strictObject({
  ...executionSpanBaseFields,
  category: z.literal('policy'),
  source: z.string(),
  action: z.string(),
  reason: z.string(),
})
export type PolicySpan = z.infer<typeof PolicySpanSchema>

/**
 * 执行 span 判别联合（判别字段 `category`）。
 *
 * 与 `SessionEntrySchema` 并列的独立契约：会话树 = 上下文权威，执行 span 树 = 可观测视图，两棵树同构
 * 不同域，靠 `requestFingerprint` + `sessionId` + `turn` 横向关联而不复制转录内容。
 */
export const ExecutionSpanSchema = z.discriminatedUnion('category', [
  RunSpanSchema,
  TurnSpanSchema,
  ModelSpanSchema,
  ToolSpanSchema,
  CapabilitySpanSchema,
  PolicySpanSchema,
])
export type ExecutionSpan = z.infer<typeof ExecutionSpanSchema>

/** 全 null 度量（无任何指标的 span 起手值）。 */
export function emptyExecutionSpanMetrics(): ExecutionSpanMetrics {
  return { latencyMs: null, tokensIn: null, tokensOut: null, costUsd: null }
}
