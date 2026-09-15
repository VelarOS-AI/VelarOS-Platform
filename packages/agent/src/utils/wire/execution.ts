// 域：Agent 执行动词；由 Agent capability 拥有，Kernel 只路由其不透明信封。
import { z } from 'zod'

import {
  ToolCatalogEntrySchema,
  VelarToolCallEnvelopeSchema,
  VelarToolResultEnvelopeSchema,
} from './lease'
import { ModelMessageSchema } from './message'

/**
 * 宿主投影：`resolveCatalog(hostProjection)` 的入参（宪章 §6 per-host 目录投影）。
 *
 * kernel 据此窄化 schema、改写描述、按宿主已有能力剔除工具族——工具目录不再全局唯一。
 */
export const HostProjectionSchema = z.strictObject({
  hostId: z.string(),
  includeCategories: z.array(z.string()).nullable(),
  excludeToolNames: z.array(z.string()).nullable(),
})
export type HostProjection = z.infer<typeof HostProjectionSchema>

/**
 * `resolveCatalog(hostProjection)` 请求。
 *
 * 响应即 {@link ToolCatalogSnapshot}（lease.ts）——目录一经解析就被对端缓存、其 `catalogRevision` 跨多轮
 * 被信封引用，是**独立流转/持久化的帧**（带 protocolVersion 章），故不另立 `{tools, catalogRevision}` 的
 * 无章 RPC 响应型（消一物两名）。
 */
export const ResolveCatalogRequestSchema = z.strictObject({
  hostProjection: HostProjectionSchema,
})
export type ResolveCatalogRequest = z.infer<typeof ResolveCatalogRequestSchema>

/** `describeToolSchema(name)` 请求。 */
export const DescribeToolSchemaRequestSchema = z.strictObject({
  name: z.string(),
})
export type DescribeToolSchemaRequest = z.infer<typeof DescribeToolSchemaRequestSchema>

/** `describeToolSchema` 响应：单个工具的精确描述符 + 目录修订号（供 schema 自恢复）。 */
export const DescribeToolSchemaResponseSchema = z.strictObject({
  tool: ToolCatalogEntrySchema,
  catalogRevision: z.string(),
})
export type DescribeToolSchemaResponse = z.infer<typeof DescribeToolSchemaResponseSchema>

/**
 * `executeTool(envelope) → result 信封`。
 *
 * 请求即工具调用信封，响应即工具结果信封——执行层是**全内核唯一工具执行路径**，
 * ApprovalPort 检查点只存在于这一层（宪章 §3）。
 */
export const ExecuteToolRequestSchema = VelarToolCallEnvelopeSchema
export type ExecuteToolRequest = z.infer<typeof ExecuteToolRequestSchema>
export const ExecuteToolResponseSchema = VelarToolResultEnvelopeSchema
export type ExecuteToolResponse = z.infer<typeof ExecuteToolResponseSchema>

/** `runTurn` 可选项：无状态单轮 loop 的模型与轮次上限（缺省用可选属性表达"未提供"）。 */
export const RunTurnOptionsSchema = z.strictObject({
  modelId: z.string().optional(),
  maxToolTurns: z.number().int().optional(),
})
export type RunTurnOptions = z.infer<typeof RunTurnOptionsSchema>

/**
 * `runTurn(messages, tools, opts)` 请求。
 *
 * 无状态单轮 loop（pi inMemory session 等价物）：传入消息与工具集，kernel 跑一轮流式 loop。
 */
export const RunTurnRequestSchema = z.strictObject({
  messages: z.array(ModelMessageSchema),
  tools: z.array(ToolCatalogEntrySchema),
  options: RunTurnOptionsSchema.optional(),
})
export type RunTurnRequest = z.infer<typeof RunTurnRequestSchema>

/** `runTurn` 响应：本轮追加的消息与本轮产生的工具结果信封。 */
export const RunTurnResponseSchema = z.strictObject({
  messages: z.array(ModelMessageSchema),
  toolResults: z.array(VelarToolResultEnvelopeSchema),
})
export type RunTurnResponse = z.infer<typeof RunTurnResponseSchema>
