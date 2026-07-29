// 域：Agent 转录 wire 形状；由 Agent capability 拥有，不进入 Kernel protocol。
import { z } from 'zod'

/** 转录角色枚举：执行层与会话层共享的最小消息角色集（对齐 KernelSessionController 输入角色）。 */
export const ModelMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool'])
export type ModelMessageRole = z.infer<typeof ModelMessageRoleSchema>

/** 纯文本片段。 */
export const TextPartSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
})

/**
 * 工具调用片段。
 *
 * `toolCallId` 是工具调用与其结果的**配对身份**，跨 host 稳定契约（宪章 §6）。
 */
export const ToolCallPartSchema = z.strictObject({
  type: z.literal('tool-call'),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
})

/** 工具结果片段；`toolCallId` 必须与对应的调用片段一致。 */
export const ToolResultPartSchema = z.strictObject({
  type: z.literal('tool-result'),
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.unknown(),
})

/** 消息内容片段判别联合（判别字段 `type`，贴仓内内容片段惯例）。 */
export const ModelMessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
])
export type ModelMessagePart = z.infer<typeof ModelMessagePartSchema>

/**
 * 转录消息 wire 形状。
 *
 * `content` 允许纯文本或片段数组；工具调用/结果通过片段内 `toolCallId` 配对，身份锁进协议。
 */
export const ModelMessageSchema = z.strictObject({
  role: ModelMessageRoleSchema,
  content: z.union([z.string(), z.array(ModelMessagePartSchema)]),
})
export type ModelMessage = z.infer<typeof ModelMessageSchema>
