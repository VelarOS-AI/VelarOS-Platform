// MCP 协议边界上的无状态解析：server 报上来的原始 JSON 与 SDK 抛出的错误，在这里收敛成本包认识的形状。
// 不持有连接、不记状态，纯函数，`McpClientConnection` 逐条调用。

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'

import { isBoolean, isRecord, isString } from '@velaros-ai/core'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { McpToolDescriptor } from '../../types/connectors.js'

/**
 * 把 `tools/list` 回来的一条原始工具 JSON 收敛成 `McpToolDescriptor`：没有 `name` 的条目返回 null（调用方跳过它），
 * `inputSchema` 缺失时兜底成空对象 schema，`description` 缺失时退回 `title`，三个 hint 缺失一律当 false（即按高风险对待）。
 */
export function parseMcpToolDescriptor(raw: unknown): Nullable<McpToolDescriptor> {
  const record = asRecord(raw) ?? {}
  const name = readString(record, 'name')
  if (!name) return null

  const inputSchema = isRecord(record.inputSchema) ? record.inputSchema : { type: 'object' }
  const description = readString(record, 'description') || readString(record, 'title')
  const annotations = isRecord(record.annotations) ? record.annotations : {}

  return {
    name,
    description: description || null,
    inputSchema,
    annotations: {
      title: readString(annotations, 'title') || null,
      readOnlyHint: isBoolean(annotations.readOnlyHint) ? annotations.readOnlyHint : false,
      destructiveHint: isBoolean(annotations.destructiveHint) ? annotations.destructiveHint : false,
      idempotentHint: isBoolean(annotations.idempotentHint) ? annotations.idempotentHint : false,
    },
  }
}

/**
 * 判一个 catch 到的东西是不是「等超时了」：MCP SDK 的 `RequestTimeout` 错误码，或 `TimeoutError`/`AbortError`。
 * 连接和调用两条路都靠它把超时和真正的协议失败分开，前者要换成带毫秒数的 TIMEOUT 文案。
 */
export function isMcpTimeoutError(error: unknown): boolean {
  const record = isRecord(error) ? error : {}
  return (
    record.code === ErrorCode.RequestTimeout ||
    (isString(record.name) && (record.name === 'TimeoutError' || record.name === 'AbortError'))
  )
}
