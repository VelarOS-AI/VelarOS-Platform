import { isNonBlankString } from '@velaros-ai/core'
/**
 * 造一个**本轮专用**的 toolCallId 分配器，保证这一轮里每个工具调用拿到互不相同的非空 id。
 *
 * 针对的供应方行为：部分网关把 toolCallId 发成空串，或并行多个工具调用时重复发同一个 id——
 * 两种都会让工具结果配错调用。传入的 id 非空且本轮没见过就原样沿用（保住与供应方的对应关系），
 * 否则顶上 `tool-call-<自增序号>` 的合成 id，并继续自增直到不与已见 id 相撞。
 * 闭包持有已见集合，所以必须每轮新建一个；跨轮复用会把上一轮的 id 也算作已占用。
 */
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
