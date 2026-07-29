import { isNonBlankString } from '@velaros-ai/core'
export function createProviderTurnToolCallIdAllocator(): (toolCallId: unknown) => string {
  const seenToolCallIds = new Set<string>()
  let nextSyntheticToolCallIndex = 0

  return (toolCallId) => {
    if (isNonBlankString(toolCallId) && !seenToolCallIds.has(toolCallId)) {
      seenToolCallIds.add(toolCallId)
      return toolCallId
    }

    let syntheticId = `tool-call-${nextSyntheticToolCallIndex++}`
    while (seenToolCallIds.has(syntheticId)) {
      syntheticId = `tool-call-${nextSyntheticToolCallIndex++}`
    }
    seenToolCallIds.add(syntheticId)
    return syntheticId
  }
}
