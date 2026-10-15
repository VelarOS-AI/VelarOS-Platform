import type { ContextRef } from '@velaros-ai/context'
import { isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { GoalLimits } from '../../system/contract/constants.js'
import type { GoalControl, GoalState, GoalUpdate } from '../../system/types/goal.js'
import type { GoalFrame } from '../types/goal.js'

/** 校验目标状态迁移和读取版本，再生成不共享可变数据的下一版。 */
export function goalChange(
  prior: Nullable<GoalState>,
  input: GoalUpdate | GoalControl,
  now: number,
  id: string,
  source: 'model' | 'user' = 'model'
): GoalState {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)
    throw new AppError('GOAL_INPUT', '目标版本无效')
  if (input.baseRevision !== (prior?.revision ?? 0))
    throw new AppError('GOAL_CONFLICT', '目标版本已变化，请重新读取')
  const controls = {
    resume: 'active',
    pause: 'paused',
    complete: 'complete',
    block: 'blocked',
    cancel: 'cancelled',
    remove: 'removed',
  } as const
  const control = 'action' in input
  if (control && !Object.hasOwn(controls, input.action))
    throw new AppError('GOAL_INPUT', '目标操作无效')
  const objective = control
    ? undefined
    : isString(input.objective)
      ? input.objective.trim()
      : undefined
  const reason = control ? (prior?.reason ?? '') : (input.reason ?? prior?.reason ?? '')
  const status = control
    ? controls[input.action]
    : (input.status ?? (objective ? 'active' : (prior?.status ?? 'active')))
  if (
    ![
      'active',
      'paused',
      'complete',
      'blocked',
      'cancelled',
      ...(control ? ['removed'] : []),
    ].includes(status) ||
    !isString(reason) ||
    reason.length > GoalLimits.reasonChars ||
    (!control &&
      !isUndefined(input.objective) &&
      (!isString(input.objective) ||
        !objective ||
        (source === 'model' && objective.length > GoalLimits.objectiveChars)))
  )
    throw new AppError('GOAL_INPUT', '目标内容或状态无效')
  if (objective && prior && (prior.status === 'active' || prior.status === 'paused'))
    throw new AppError('GOAL_INPUT', '先结束当前目标，再建立新目标')
  const creating = !!objective
  if ((!prior || prior.status === 'removed') && !creating)
    throw new AppError('GOAL_INPUT', '新目标需要内容和 active 状态')
  if (
    !creating &&
    prior &&
    ['complete', 'cancelled'].includes(prior.status) &&
    status !== 'removed'
  )
    throw new AppError('GOAL_INPUT', '目标已结束，请明确建立新目标')
  if (!control && (status === 'complete' || status === 'blocked') && !input.reason?.trim())
    throw new AppError('GOAL_INPUT', '完成或受阻需要说明实际依据')
  return {
    id: creating ? id : prior!.id,
    revision: input.baseRevision + 1,
    objective: objective ?? prior!.objective,
    status,
    reason: creating ? ('reason' in input ? (input.reason ?? '') : '') : reason,
    createdAt: creating ? now : prior!.createdAt,
    updatedAt: now,
  }
}

/** 只缩减展示：整字段换成可召回引用，原文、版本与状态不裁剪；最小元数据允许超出软预算。 */
export function goalFrame(goal: GoalState, ref: ContextRef, maxChars: number): GoalFrame {
  let frame: GoalFrame = goal
  if (JSON.stringify(frame).length <= maxChars) return frame
  const fields = (['objective', 'reason'] as const).toSorted(
    (left, right) => JSON.stringify(goal[right]).length - JSON.stringify(goal[left]).length
  )
  for (const field of fields) {
    const { [field]: _body, ...metadata } = frame
    const next: GoalFrame = {
      ...metadata,
      [`${field}InRecord`]: { ref, pointer: `/${field}`, chars: goal[field].length },
    }
    if (JSON.stringify(next).length >= JSON.stringify(frame).length) continue
    frame = next
    if (JSON.stringify(frame).length <= maxChars) break
  }
  return frame
}
