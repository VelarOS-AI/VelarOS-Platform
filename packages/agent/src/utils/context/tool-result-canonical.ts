import type { CanonicalizeToolResultInput, CanonicalToolResult, ContextPayloadRecord } from '../../types/context.js'

/**
 * 按已经归档好的 payload 记录，拼出一次工具结果的归一化回执。
 *
 * `action` 由调用方判定：`inline`（正文没超预算，照常内联）、`reference`（超了，改用地址）、
 * `dedupe-reference`（这段正文之前就归档过，指回最早那次）。
 * `sameAsToolCallId` 只有 dedupe 那条路才给，指向最早存下这段正文的那次调用，让界面能说清"同上"。
 * 可见部分的 `toolCallId` / `toolName` 一律取**本次**调用，地址与哈希取记录，两者不能混。
 */
export function buildCanonicalToolResult(
  input: CanonicalizeToolResultInput,
  record: ContextPayloadRecord,
  action: CanonicalToolResult['action'],
  sameAsToolCallId?: string,
): CanonicalToolResult {
  return {
    action,
    hash: record.hash,
    payloadRef: record.payloadRef,
    record,
    visible: {
      type: 'tool-payload-ref',
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      payloadRef: record.payloadRef,
      hash: record.hash,
      chars: record.chars,
      sameAsToolCallId,
    },
  }
}
