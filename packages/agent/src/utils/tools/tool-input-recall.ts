import type { ContextPayloadStore } from '../../contract/requires.js'
import { sha256 } from '../context/content-hash'
import { buildContextPayloadRef } from '../context/payload-ref'

import { findHistoryPreviewPlaceholderArgumentPaths } from './history-preview-placeholder'
import { compactToolInputForModel } from './tool-result-serialization'

/**
 * 只把「在模型历史里被压缩过」的工具入参落一份可召回的载荷，而且必须赶在工具产生任何副作用之前存。
 *
 * 没被压缩的入参模型自己就看得全，不必占存储；存晚了则可能工具已经改过东西、原参数却没留下，失败后无从复用。
 */
export async function persistToolInputForRecall(input: {
  store: ContextPayloadStore
  sessionId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}): Promise<void> {
  const ref = `input:${input.toolCallId}`
  if (
    input.args.__historyInputRef ||
    input.args.__historyInputOmissions ||
    input.args.__historyInputPreview ||
    findHistoryPreviewPlaceholderArgumentPaths(input.args).length > 0
  )
    return
  if (compactToolInputForModel(input.args, input.toolCallId).__historyInputRef !== ref) return
  const serializedResult = JSON.stringify(input.args)
  // 带上调用身份：不同调用的相同输入也要各自有独立的查找句柄。
  const hash = sha256(`${ref}\n${serializedResult}`)
  await input.store.put({
    sessionId: input.sessionId,
    hash,
    payloadRef: buildContextPayloadRef(input.sessionId, hash),
    toolCallId: ref,
    toolName: input.toolName,
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
}
