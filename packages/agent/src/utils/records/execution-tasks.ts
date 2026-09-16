import { AppError } from '@velaros-ai/core/error'

import type { ExecutionRecord, ExecutionTaskRecord } from '../../types/agent.js'

/**
 * 取执行记录里 `currentTaskId` 指向的那个任务。
 *
 * 指不到任务说明这条账本已经坏了（焦点悬空），不是调用方传错，所以直接抛 `INVARIANT`；
 * `operation` 写清是哪一步撞上的，跟着错误细节一起留给诊断。
 */
export function requireCurrentTask(execution: ExecutionRecord, operation: string): ExecutionTaskRecord {
  const currentTaskId = execution.currentTaskId
  const task = execution.tasks.find((item) => item.id === currentTaskId)
  if (task) return task

  throw new AppError(
    'INVARIANT',
    `执行记录 ${execution.id} 的当前任务 ${currentTaskId} 不存在：这是内部缺陷（账本的焦点悬空了），不是调用方传错，请连同 operation=${operation} 一起报缺陷。`,
    undefined,
    {
      executionId: execution.id,
      currentTaskId,
      operation,
    }
  )
}
