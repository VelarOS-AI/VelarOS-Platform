import {Log} from '@velaros-ai/core'
import {toNullable} from '@velaros-ai/core'
import { isEmpty, isObject, isString } from '@velaros-ai/core'
import { unifiedLineDiff } from '@velaros-ai/core/utils/textDiff'

import type { ContextContent, ContextEvidence, ContextProgress, ContextTaskFrame, ContextTaskState, ContextTextChange } from '../contract/context.js'

/** 相同持久对象视为未变，差量只包含片段并明确标出被截断的部分。 */
export function contextTextChange(before?: ContextContent, after?: ContextContent): ContextTextChange {
  const text = (value?:ContextContent):string => {
    if (!value) return ''
    try {
      const parsed:unknown = JSON.parse(value.text)
      if (parsed && isObject(parsed) && 'source' in parsed && isString(parsed.source)) return parsed.source + ('modules' in parsed ? `\n// modules\n${JSON.stringify(parsed.modules)}` : '')
      if (parsed && isObject(parsed) && 'checked' in parsed && 'result' in parsed) return JSON.stringify({checked:parsed.checked,result:parsed.result})
    } catch {Log.tag('ActRuntime').debug('progress 已进入异常处理或降级分支'); /* 不完整 JSON 片段直接展示，恢复依然使用原记录。 */ }
    return value.text
  }
  const complete = (!before || before.text.length === before.totalChars) && (!after || after.text.length === after.totalChars)
  const changed = complete ? text(before) !== text(after) : before?.record.objectId !== after?.record.objectId
  const patch = changed ? unifiedLineDiff(text(before),text(after),{from:before?.record.ref.id ?? 'empty',to:after?.record.ref.id ?? 'empty',editLimit:128,contextLines:2}) : ''
  return {from:toNullable(before?.record.ref),to:toNullable(after?.record.ref),changed,patch:patch.slice(0,1200),truncated:patch.length > 1200 || Boolean(before && before.text.length < before.totalChars) || Boolean(after && after.text.length < after.totalChars)}
}

/** 只比较上一份已发布视图与当前事实，不用候选预览推断工作进展。 */
export function contextProgress(task: ContextTaskState, frame: ContextTaskFrame, evidence: readonly ContextEvidence[]): ContextProgress {
  const previous = task.view
  const script = contextTextChange(previous?.lastStep?.source,frame.lastStep?.source)
  const result = contextTextChange(previous?.lastStep?.result,frame.lastStep?.result)
  const old = new Map((previous?.evidence ?? []).map(item=>[JSON.stringify(item.target),item]))
  const changes:Array<ContextProgress['evidence'][number]> = []
  let unchangedEvidence = 0
  let patchBudget = 2400
  const delta = (before?:ContextEvidence,after?:ContextEvidence):{patch:string;truncated:boolean} => {
    const patch=unifiedLineDiff(before?.body ?? '',after?.body ?? '',{from:before?.hash ?? 'empty',to:after?.hash ?? 'empty',editLimit:128,contextLines:2})
    const shown=patch.slice(0,Math.min(800,patchBudget));patchBudget-=shown.length
    return {patch:shown,truncated:shown.length<patch.length}
  }
  for (const item of evidence) {
    const key = JSON.stringify(item.target); const prior = old.get(key)
    old.delete(key)
    if (!prior || prior.hash !== item.hash || JSON.stringify(prior.readSet.map(stamp=>stamp.revision)) !== JSON.stringify(item.readSet.map(stamp=>stamp.revision))) changes.push({...delta(prior,item),target:item.target,change:prior?'updated':'added',before:toNullable(prior?.hash),after:item.hash})
    else unchangedEvidence++
  }
  for (const prior of old.values()) changes.push({...delta(prior),target:prior.target,change:'removed',before:prior.hash,after:null})
  const newStep = Boolean(frame.lastStep && previous?.lastStep?.result.record.ref.id !== frame.lastStep.result.record.ref.id)
  const imagesChanged = JSON.stringify(previous?.lastStep?.attachments?.map(image=>image.hash) ?? []) !== JSON.stringify(frame.lastStep?.attachments?.map(image=>image.hash) ?? [])
  const noProgress = Boolean(previous && !imagesChanged && !script.changed && !result.changed && isEmpty(changes) && JSON.stringify(frame.capsule) === JSON.stringify(previous.capsule) && !frame.mandatory.some(item=>item.executionId === task.executionId && item.operation !== 'script.execute' && !/^velaros:(?:script|artifacts|modules|programs|results)\./u.test(item.operation) && ['committed','partial','unknown'].includes(item.effect)))
  const repeatedSteps = newStep ? (noProgress ? (previous?.progress?.repeatedSteps ?? 0) + 1 : 0) : previous?.progress?.repeatedSteps ?? 0
  return {imagesChanged,step:task.step ?? 0,previousViewId:toNullable(previous?.id),script,result,evidence:changes,unchangedEvidence,repeatedSteps,stalled:repeatedSteps >= 3}
}
