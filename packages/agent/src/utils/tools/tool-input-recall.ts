import type { ContextPayloadStore } from '../../impl/context/InMemoryContextPayloadStore'
import { createContextPayloadRef } from '../../impl/context/InMemoryContextPayloadStore'
import { sha256 } from '../context/content-hash'

import { findHistoryPreviewPlaceholderArgumentPaths } from './history-preview-placeholder'
import { compactToolInputForModel } from './tool-result-serialization'

/** Save only inputs shortened in model history, before any tool side effect. */
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
    payloadRef: createContextPayloadRef(input.sessionId, hash),
    toolCallId: ref,
    toolName: input.toolName,
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
}
