import { isArray, isEmpty, isPlainObject, isString, isTrue } from '@velaros-ai/core'

import type { DecisionStateProjection } from '../types/memory.js'

import { ActRuntimeTuning } from './tuning.js'

/** 只裁剪可召回细节；当前身份、有序列表、约束、障碍与 required 缺口保持完整。 */
export function decisionStateProjection(
  runtime: Record<string, unknown>,
  active: unknown,
  budget: number
): DecisionStateProjection {
  const originalChars = JSON.stringify({ active, runtime }).length
  const current = { ...runtime }
  const recalled: string[] = []
  if (originalChars > budget && isArray(runtime.readSet) && !isEmpty(runtime.readSet)) {
    current.readSet = { count: runtime.readSet.length, pointer: '/readSet' }
    recalled.push('/readSet')
  }
  if (originalChars > budget && isPlainObject(runtime.progress)) {
    const progress = { ...runtime.progress }
    for (const name of ['script', 'observation']) {
      const change = progress[name]
      if (!isPlainObject(change) || !isString(change.patch) || !change.patch) continue
      const patch = change.patch.slice(0, ActRuntimeTuning.statePatchChars)
      if (patch.length === change.patch.length) continue
      progress[name] = {
        ...change,
        patch,
        patchChars: change.patch.length,
        patchTruncated: true,
        pointer: `/progress/${name}/patch`,
      }
      recalled.push(`/progress/${name}/patch`)
    }
    current.progress = progress
  }
  const requiredIntents = new Set(
    isArray(runtime.gaps)
      ? runtime.gaps.flatMap((gap) =>
          isPlainObject(gap) && isTrue(gap.required) && isString(gap.intentId) ? [gap.intentId] : []
        )
      : []
  )
  if (isArray(runtime.evidence)) {
    const evidence = runtime.evidence.map((item) => (isPlainObject(item) ? { ...item } : item))
    current.evidence = evidence
    const optional = evidence.flatMap((item, index) =>
      isPlainObject(item) &&
      isString(item.body) &&
      isTrue(item.complete) &&
      !(isArray(item.intentIds) && item.intentIds.some((id) => requiredIntents.has(String(id))))
        ? [{ item, index }]
        : []
    )
    let currentChars = JSON.stringify({ active, runtime: current }).length
    for (const { item, index } of optional) {
      if (currentChars <= budget) break
      if (isArray(item.readSet) && !isEmpty(item.readSet)) {
        item.readSet = { count: item.readSet.length, pointer: `/evidence/${index}/readSet` }
        recalled.push(`/evidence/${index}/readSet`)
      }
      currentChars = JSON.stringify({ active, runtime: current }).length
    }
    for (const { item, index } of optional.toReversed()) {
      if (currentChars <= budget) break
      const body = String(item.body)
      const excess = currentChars - budget
      const kept = Math.max(0, body.length - excess - ActRuntimeTuning.stateRecallChars)
      if (kept >= body.length) continue
      item.body = body.slice(0, kept)
      item.bodyChars = body.length
      item.bodyComplete = false
      item.bodyRepresentation = kept ? 'excerpt' : 'reference'
      item.pointer = `/evidence/${index}/body`
      recalled.push(`/evidence/${index}/body`)
      currentChars = JSON.stringify({ active, runtime: current }).length
    }
  }
  const shownChars = JSON.stringify({ active, runtime: current }).length
  return {
    runtime: current,
    details: [...new Set(recalled)],
    budget,
    originalChars,
    shownChars,
    savedChars: Math.max(0, originalChars - shownChars),
    overBudget: shownChars > budget,
  }
}
