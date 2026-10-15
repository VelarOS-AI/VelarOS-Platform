import type { ContextRef } from '@velaros-ai/context'

import type { GoalState } from '../../system/types/goal.js'

/** 目标正文所在的不可变记录；按 memory.read 的 ref、pointer 和 UTF-16 范围读取。 */
export interface GoalFieldReference {
  readonly ref: ContextRef
  readonly pointer: '/objective' | '/reason'
  readonly chars: number
}

/** 工作帧保持目标元数据；超出展示预算的整字段以明确的原文引用代替。 */
export interface GoalFrame extends Omit<GoalState, 'objective' | 'reason'> {
  readonly objective?: string
  readonly objectiveInRecord?: GoalFieldReference
  readonly reason?: string
  readonly reasonInRecord?: GoalFieldReference
}
