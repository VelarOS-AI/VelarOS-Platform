import type { ContextTaskState } from './context.js'

/** 内部任务提交函数；只作用于既有 ContextStorage 的 CAS。 */

export interface ContextTaskMutation {
  /** 返回下一份任务状态，抛错表示拒绝提交。 */
  apply(current: Optional<ContextTaskState>): ContextTaskState
}
