// 域：Agent 会话动词与会话树 entry；不进入 Kernel protocol。
import { z } from 'zod'

import { ModelMessagePartSchema, ModelMessageRoleSchema, ModelMessageSchema } from './message'

/**
 * 输入投递方式：入队（当前回合收敛后消费）或引导（运行中插入，见 §3 steer 动词）。
 *
 * 对齐控制器 `KernelInputDelivery`（`'queue' | 'steer'`）。子字段枚举不单列进快照注册表
 * （贴 `ModelMessageRole` / `LeaseDenialReason` 惯例——sub-field 枚举随载它的帧一起序列化）。
 */
export const SessionInputDeliverySchema = z.enum(['queue', 'steer'])
export type SessionInputDelivery = z.infer<typeof SessionInputDeliverySchema>

/**
 * 会话树 entry 公共字段。
 *
 * `parentId` 是树形指针（宪章 §6）；根 entry 无父，按宪章 §12.6 用 `Nullable` 表达缺席（值缺席用 null）。
 */
const sessionEntryBaseFields = {
  id: z.string(),
  parentId: z.string().nullable(),
  createdAt: z.number().int(),
}

/**
 * 会话信息 entry：会话级元数据头（pi `SessionInfoEntry` 先例）。
 *
 * 声明式 `spaceId`——成员会话固定的工作区空间身份（宪章 §2「会话声明式 spaceId」阶段①）。
 * **开放字符串**而非枚举:注册轴开放后空间 id 可超出三预制,spaceId 校验在边界对 SpaceRegistry
 * 做,不烧进 wire 枚举（新空间零协议改动）。会话创建时追加一次;缺席 = 旧会话按运行态推断（双轨,
 * 零迁移）。
 */
export const SessionInfoEntrySchema = z.strictObject({
  ...sessionEntryBaseFields,
  type: z.literal('session-info'),
  spaceId: z.string(),
})
export type SessionInfoEntry = z.infer<typeof SessionInfoEntrySchema>

/** 普通消息 entry：承载一条转录消息。 */
export const MessageEntrySchema = z.strictObject({
  ...sessionEntryBaseFields,
  type: z.literal('message'),
  message: ModelMessageSchema,
})
export type MessageEntry = z.infer<typeof MessageEntrySchema>

/** 压缩 entry：压缩/handoff/蒸馏折叠的治理产物即会话数据，记录被替换的 entry。 */
export const CompactionEntrySchema = z.strictObject({
  ...sessionEntryBaseFields,
  type: z.literal('compaction'),
  summary: z.string(),
  replacedEntryIds: z.array(z.string()),
})
export type CompactionEntry = z.infer<typeof CompactionEntrySchema>

/**
 * 自定义 entry：落盘但不进上下文的开放数据面（宪章 §6 `appendEntry(customType, data)`）。
 *
 * `data` 类型自 declare，内核不枚举用途，壳层当**不透明信封**透传（渲染需壳层沙箱边界）。
 */
export const CustomEntrySchema = z.strictObject({
  ...sessionEntryBaseFields,
  type: z.literal('custom'),
  customType: z.string(),
  data: z.unknown(),
})
export type CustomEntry = z.infer<typeof CustomEntrySchema>

/** 自定义消息 entry：进上下文参与推理的开放数据面（宪章 §6 `sendMessage({customType})`）。 */
export const CustomMessageEntrySchema = z.strictObject({
  ...sessionEntryBaseFields,
  type: z.literal('custom-message'),
  customType: z.string(),
  message: ModelMessageSchema,
  data: z.unknown(),
})
export type CustomMessageEntry = z.infer<typeof CustomMessageEntrySchema>

/** 模型切换 entry：记录会话中途更换模型。 */
export const ModelChangeEntrySchema = z.strictObject({
  ...sessionEntryBaseFields,
  type: z.literal('model-change'),
  fromModelId: z.string().nullable(),
  toModelId: z.string(),
})
export type ModelChangeEntry = z.infer<typeof ModelChangeEntrySchema>

/** 分支摘要 entry：fork/branch 出的旁支归纳，指向被摘要的分支 entry。 */
export const BranchSummaryEntrySchema = z.strictObject({
  ...sessionEntryBaseFields,
  type: z.literal('branch-summary'),
  summary: z.string(),
  branchEntryId: z.string(),
})
export type BranchSummaryEntry = z.infer<typeof BranchSummaryEntrySchema>

/**
 * 会话树 entry 判别联合（判别字段 `type`，贴仓内内容片段惯例）。
 *
 * **开放追加，不开放修改**（宪章 §6）：一切治理产物都是带类型的会话条目，可审计可重放；
 * 新增治理产物 = 追加一个新 entry 类型，已发布类型的字段在同 major 内不改。
 */
export const SessionEntrySchema = z.discriminatedUnion('type', [
  SessionInfoEntrySchema,
  MessageEntrySchema,
  CompactionEntrySchema,
  CustomEntrySchema,
  CustomMessageEntrySchema,
  ModelChangeEntrySchema,
  BranchSummaryEntrySchema,
])
export type SessionEntry = z.infer<typeof SessionEntrySchema>

/** 会话目标：`sessionId` + 可选序号锚点（缺席用 Nullable）。 */
export const SessionTargetSchema = z.strictObject({
  sessionId: z.string(),
  seq: z.number().int().nullable(),
})
export type SessionTarget = z.infer<typeof SessionTargetSchema>

/**
 * 动词 `admit`：接纳一条输入进会话（六动词之一）。
 *
 * 对齐控制器 `KernelControllerSendInput`（`admit` 的真入参）：`role` / `delivery` / `metadata` 缺席用
 * 值缺席（§12.6 Nullable）；`content` 是当前权威载荷（纯文本）。`parts` 为多段输入预留（文本 + 附件等），
 * **纯可选**、当前未启用——启用前一律以 `content` 为准，reader 无需分支即可读到完整字符串。
 */
export const AdmitRequestSchema = z.strictObject({
  sessionId: z.string(),
  inputId: z.string(),
  role: ModelMessageRoleSchema.nullable(),
  content: z.string(),
  /** 投递方式（缺席按控制器默认 `queue`）。 */
  delivery: SessionInputDeliverySchema.nullable(),
  /** 宿主透传的输入元数据（不透明信封，内核不枚举用途；缺席用 null）。 */
  metadata: z.record(z.string(), z.unknown()).nullable(),
  /** 多段输入预留（forward-compat，纯可选）；当前 `content` 为权威载荷。 */
  parts: z.array(ModelMessagePartSchema).optional(),
})
export type AdmitRequest = z.infer<typeof AdmitRequestSchema>

/** `admit` 回执：分配的输入序号。 */
export const AdmitReceiptSchema = z.strictObject({
  inputId: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
})
export type AdmitReceipt = z.infer<typeof AdmitReceiptSchema>

/** 动词 `wake`：唤醒会话推进当前回合（六动词之一）。 */
export const WakeRequestSchema = SessionTargetSchema
export type WakeRequest = z.infer<typeof WakeRequestSchema>

/**
 * 动词 `steer`：会话运行中插入引导输入（六动词之一）。
 *
 * 对齐控制器 `steer`（复用 `KernelControllerSendInput`，`delivery` 固定 `steer`）：补 `role` 令引导输入
 * 可标注来源角色（缺席用 null，贴 `AdmitRequest.role` 口径）。
 */
export const SteerRequestSchema = z.strictObject({
  sessionId: z.string(),
  inputId: z.string(),
  role: ModelMessageRoleSchema.nullable(),
  content: z.string(),
})
export type SteerRequest = z.infer<typeof SteerRequestSchema>

/** 动词 `answer`：回答会话抛出的提问（六动词之一）。 */
export const AnswerRequestSchema = z.strictObject({
  sessionId: z.string(),
  seq: z.number().int().nullable(),
  answer: z.string(),
})
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>

/**
 * 动词 `approve`：审批一次待确认动作，批准或带理由拒绝（六动词之一，经 ApprovalPort）。
 *
 * 对齐控制器 `KernelControllerApprovalInput.approvalPayload`：审批载荷对内核不透明（宿主适配器声明其
 * 正式类型，如 Desktop 的 confirmation 卡片结果 `UserActionCardResult[]`——hooks cardResults 已上线的
 * 通道）。协议面按不透明信封 `z.unknown()` 承载，缺席用 null（§12.6）。
 */
export const ApproveRequestSchema = z.strictObject({
  sessionId: z.string(),
  seq: z.number().int().nullable(),
  approved: z.boolean(),
  rejectionMessage: z.string().nullable(),
  approvalPayload: z.unknown().nullable(),
})
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>

/** 动词 `cancel`：中止当前回合（六动词之一）。 */
export const CancelRequestSchema = SessionTargetSchema
export type CancelRequest = z.infer<typeof CancelRequestSchema>

/** `cancel` 结果：是否成功中止。 */
export const CancelResultSchema = z.strictObject({
  aborted: z.boolean(),
})
export type CancelResult = z.infer<typeof CancelResultSchema>

/**
 * 读动词 `runtimeStatus` 请求：读取会话运行态（对齐控制器 `runtimeStatus(target)`）。
 *
 * 请求形状 = {@link SessionTarget}（贴 `wake` / `cancel` 复用 target 的惯例，不单列进快照注册表）。
 */
export const RuntimeStatusRequestSchema = SessionTargetSchema
export type RuntimeStatusRequest = z.infer<typeof RuntimeStatusRequestSchema>

/**
 * 读动词 `runtimeStatus` 响应：会话运行态快照（对齐控制器 `KernelRuntimeStatus`，协议侧独立再声明）。
 *
 * RPC 配对形（读动词的请求/响应），**不带 protocolVersion 章**——版本已在握手协商，配对帧无需逐帧盖章
 * （见 README「protocolVersion 钉章规则」）。派生量 `pendingPrompt` / `cancellable` 由签发方算好带出，
 * 消费面零推导。
 */
export const RuntimeStatusResponseSchema = z.strictObject({
  hasPendingConfirmation: z.boolean(),
  hasPendingInput: z.boolean(),
  running: z.boolean(),
  /** 派生量：有待确认或待处理输入（`hasPendingConfirmation || hasPendingInput`）。 */
  pendingPrompt: z.boolean(),
  cancelRequested: z.boolean(),
  /** 派生量：当前是否可中止（运行中 / 待处理 / 有排队输入 / 有后台任务）。 */
  cancellable: z.boolean(),
  queuedInputs: z.number().int(),
  backgroundJobs: z.number().int(),
})
export type RuntimeStatusResponse = z.infer<typeof RuntimeStatusResponseSchema>

/**
 * 会话事件占位负载联合（判别字段 `kind`）。
 *
 * v0 **只锁信封外形，不复制 agent-runtime 内部事件类型**（宪章 §5）——后续会话簇搬迁时
 * 以真实 `AgentSessionEvent` 替换本占位，判别字段保持稳定。两个占位变体分别代表
 * "内核已知的生命周期事件"与"壳层透传的自定义事件"，标注为 v0 placeholder。
 */
export const SessionEventPayloadSchema = z.discriminatedUnion('kind', [
  // 占位：生命周期事件（真实负载后续接 AgentSessionEvent）。
  z.strictObject({
    kind: z.literal('lifecycle'),
    phase: z.string(),
  }),
  // 占位：壳层透传的自定义事件（对齐 §6 开放数据面）。
  z.strictObject({
    kind: z.literal('custom'),
    customType: z.string(),
    data: z.unknown(),
  }),
])
export type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>

/**
 * `subscribe(sessionId)` 事件信封。
 *
 * 所有前端都是事件客户端（宪章 §1 pi subscribe 模型）；`sequence` 单调递增支持重连重放。
 */
export const SessionEventEnvelopeSchema = z.strictObject({
  sessionId: z.string(),
  sequence: z.number().int(),
  event: SessionEventPayloadSchema,
})
export type SessionEventEnvelope = z.infer<typeof SessionEventEnvelopeSchema>
