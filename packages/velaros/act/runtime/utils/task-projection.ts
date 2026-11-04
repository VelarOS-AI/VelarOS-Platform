import type { ContextRef } from '@velaros-ai/context'

import type { ActiveContextState } from '../../system/types/maintenance.js'

/** 连续同会话引用只写一次会话身份；保留次序、重复项与每个原文召回地址。 */
function taskPendingProjection(refs: readonly ContextRef[]) {
  const groups: Array<{ sessionId: string; ids: string[] }> = []
  for (const ref of refs) {
    const last = groups.at(-1)
    if (last?.sessionId === ref.sessionId) last.ids.push(ref.id)
    else groups.push({ sessionId: ref.sessionId, ids: [ref.id] })
  }
  const compact = {
    representation: 'ordered-ref-groups',
    count: refs.length,
    groups,
    recall:
      '按 groups 顺序将每个 id 与该组 sessionId 组成 ref，用 memory.read 召回；分组不表示已核对或已完成。',
  }
  return refs.length > 32 && JSON.stringify(compact).length < JSON.stringify(refs).length
    ? compact
    : refs
}

/** 只分层展示，不推断目标完成或输入失效；完整维护状态与原始来源保持不变。 */
export function taskActiveProjection(
  active: ActiveContextState,
  latestInput?: ContextRef,
  historicalSources?: ReadonlySet<string>
) {
  const latest = (ref: ContextRef) =>
    ref.sessionId === latestInput?.sessionId && ref.id === latestInput.id
  // 没有最新输入锚点时不猜测历史边界；reviewed 状态沿用完整认识。
  if (!latestInput || active.status !== 'pending-review') return { active, latestInput }
  const historicalInputs = active.pendingInputs.filter((ref) => !latest(ref))
  const historicalIds = new Set(historicalInputs.map((ref) => `${ref.sessionId}:${ref.id}`))
  const historicalQuestions = active.items.filter(
    (item) =>
      item.kind === 'question' &&
      (historicalSources
        ? item.sources.some((ref) => historicalSources.has(`${ref.sessionId}:${ref.id}`))
        : true)
  )
  const historicalQuestionIds = new Set(historicalQuestions.map((item) => item.id))
  return {
    latestInput,
    active: {
      ...active,
      items: active.items.filter((item) => !historicalQuestionIds.has(item.id)),
      pendingInputs: active.pendingInputs.filter(latest),
    },
    historicalInterpretation: {
      status: 'pending-review',
      meaning:
        '待核对的历史模型认识，不是当前授权任务清单；分层不表示已完成、已取消或约束失效。用户原文优先，相关历史可按 sources 或 pendingInputs 召回；无需为此强制反思。',
      items: historicalQuestions,
      pendingInputs: taskPendingProjection(historicalInputs),
    },
  }
}
