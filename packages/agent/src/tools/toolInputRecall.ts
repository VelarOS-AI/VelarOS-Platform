import type { ContextPayloadStore } from '../agent/context/ContextPayloadStore'
import { createContextPayloadRef } from '../agent/context/ContextPayloadStore'
import { sha256 } from '../agent/context/providerRequest/contentHash'

import { findHistoryPreviewPlaceholderArgumentPaths } from './historyPreviewPlaceholder'
import { compactToolInputForModel } from './toolResultSerialization'

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
    input.args.__historyInputPreview ||
    findHistoryPreviewPlaceholderArgumentPaths(input.args).length > 0
  )
    return
  if (compactToolInputForModel(input.args, input.toolCallId).__historyInputRef !== ref) return
  const serializedResult = JSON.stringify(input.args)
  // Include the call identity: identical inputs from separate calls need separate lookup handles.
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
