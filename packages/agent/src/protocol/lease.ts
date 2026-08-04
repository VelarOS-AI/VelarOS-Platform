// 域：Agent 工具契约租约；属于 Agent capability protocol，不属于 Kernel protocol。
import { z } from 'zod'

import { AgentProtocolVersion } from './version'

/**
 * 租约强制续租时间窗口：10 分钟。
 *
 * 宪章 §10 守护清单校准值，**原样带走、禁顺手重估**；只能被新实验推翻，不能被新架构删除。
 */
export const LeaseRenewalWindowMs = 10 * 60 * 1000

/**
 * 租约强制续租轮次上限：6 轮。
 *
 * 宪章 §10 守护清单校准值，与 {@link LeaseRenewalWindowMs} 同源，原样。
 */
export const LeaseRenewalTurnLimit = 6

/** 目录自恢复发现工具名：拉取当前完整工具清单（宪章 §3）。 */
export const ToolCatalogDiscoveryToolName = 'tooling:catalog'

/** schema 自恢复发现工具名：按需拉取某工具的精确输入 schema（宪章 §3）。 */
export const ToolSchemaDiscoveryToolName = 'tooling:schema'

/**
 * 单个工具目录条目。
 *
 * `inputSchema` 是 per-host 投影后的窄化 schema（宪章 §6 per-host 目录投影）。
 */
export const ToolCatalogEntrySchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  category: z.string().optional(),
  readOnly: z.boolean().optional(),
})
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>

/**
 * 工具目录快照：`catalogRevision` 绑定精确的可见工具集。
 *
 * `catalogRevision` 语义 = sha256(工具 schema bundle)，作为不透明字符串在协议里流转。
 */
export const ToolCatalogSnapshotSchema = z.strictObject({
  protocolVersion: z.literal(AgentProtocolVersion),
  catalogRevision: z.string(),
  tools: z.array(ToolCatalogEntrySchema),
})
export type ToolCatalogSnapshot = z.infer<typeof ToolCatalogSnapshotSchema>

/**
 * 契约租约的**跨边界 wire 面**（收敛到消费者跨信任边界真正需要的字段）。
 *
 * - `contractId` 语义 = sha256(device:session:revision)，标识当前执行协议（宪章 §3）。
 * - `catalogRevision` 绑定该租约生效时的工具集修订号。
 * - `needsRefresh` 告知对端下一回合前须续租。
 * - `expiresInMs` 是**签发方算好的相对续租时限**（缺席用 null）——跨信任边界对端无法比较签发方的绝对
 *   墙钟，故不出 `renewedAt` 时间戳，只出相对 TTL 这一可消费量。
 *
 * 簿记态 `renewedAt` / `turnsSinceRefresh`（驱动 10min-6 轮强制续租判定的签发方内部账）**留内部形**
 * （web 桥的 `WebConversationToolContractBinding`），不出 wire（宪章 §6 wire 裁决③ 同源纪律：transport
 * 会话态不进泛化契约）。
 */
export const ContractLeaseSchema = z.strictObject({
  contractId: z.string(),
  catalogRevision: z.string(),
  needsRefresh: z.boolean(),
  expiresInMs: z.number().int().nullable(),
})
export type ContractLease = z.infer<typeof ContractLeaseSchema>

/**
 * 工具调用信封（远端大脑 → kernel）。
 *
 * 双向都携带 `contractId` + `catalogRevision`。信封是**执行请求，不是授权令牌**——
 * kernel 的 ToolRegistry / policy / ApprovalPort 才是权威（宪章 §3）。
 */
export const VelarToolCallEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(AgentProtocolVersion),
  contractId: z.string(),
  catalogRevision: z.string(),
  toolCallId: z.string().trim().min(1),
  toolName: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
})
export type VelarToolCallEnvelope = z.infer<typeof VelarToolCallEnvelopeSchema>

/** 工具结果状态：成功 / 执行出错 / 权限拒绝。 */
export const VelarToolResultStatusSchema = z.enum(['success', 'error', 'denied'])
export type VelarToolResultStatus = z.infer<typeof VelarToolResultStatusSchema>

/**
 * 工具结果信封（kernel → 远端大脑）。
 *
 * 同样携带 `contractId` + `catalogRevision`（双信封对称）。`output` 在成功时出现，
 * `error` 在出错/拒绝时出现——两者都是可选属性（未提供即语言原生 undefined）。
 */
export const VelarToolResultEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(AgentProtocolVersion),
  contractId: z.string(),
  catalogRevision: z.string(),
  toolCallId: z.string().trim().min(1),
  toolName: z.string().trim().min(1),
  status: VelarToolResultStatusSchema,
  output: z.unknown().optional(),
  error: z.string().optional(),
})
export type VelarToolResultEnvelope = z.infer<typeof VelarToolResultEnvelopeSchema>

/**
 * 租约拒绝原因。
 *
 * 覆盖 web 桥"stale / unknown / malformed / out-of-scope"四类拒绝前置校验（web-agent-bridge 文档）。
 */
export const LeaseDenialReasonSchema = z.enum([
  'stale-revision',
  'unknown-contract',
  'unknown-tool',
  'out-of-scope',
  'malformed',
])
export type LeaseDenialReason = z.infer<typeof LeaseDenialReasonSchema>

/**
 * 目录修订失配时的拒绝响应。
 *
 * 与工具结果信封的 `status: 'denied'`（权限拒绝）是**两个不同的 denied**：本响应是**执行前**的租约层
 * 拒绝，回传 `latestCatalogRevision` 触发客户端续租，**不崩**（宪章 §3 / 拓扑 §五 运行期续租动词）。
 *
 * `status` 用**判别字面量** `'lease-denied'`（不再与结果信封的 `'denied'` 同名）——让消费者按判别字段一眼
 * 区分两种 denied，取代旧的 `'reason' in outcome` 结构嗅探。对外压平到插件的 wire（结果信封 denied）由
 * web 桥映射层保形，本改动只动内核内部的租约层判别（宪章 §6 wire 裁决④）。
 */
export const LeaseDeniedResponseSchema = z.strictObject({
  protocolVersion: z.literal(AgentProtocolVersion),
  status: z.literal('lease-denied'),
  reason: LeaseDenialReasonSchema,
  contractId: z.string().nullable(),
  latestCatalogRevision: z.string(),
})
export type LeaseDeniedResponse = z.infer<typeof LeaseDeniedResponseSchema>
