import { isEmpty } from '@velaros-ai/core'

import type { KernelToolLoopGuardApi as KernelToolLoopGuardContract } from '../../types/loop.js'
import type { KernelToolFailureBatchEntry, KernelToolLoopGuardInput } from '../../types/tools.js'
import { buildFailureBatchKey, buildSuccessKey, isKernelWriteLikeTool } from '../../utils/tools/kernel-tool-loop-guard'

import { ExecutionProgress } from './ExecutionProgress'

/**
 * 工具成环闸：按「同一写型工具重复成功」「同一批失败重复出现」「同一资源反复修不好」三条线认出空转。
 *
 * 由 `ToolExecutor` 每条执行链持有一份（宿主没注入就自建），状态只在这一份实例里跨回合累积。
 * 三条线都只返回给模型看的提示，不阻断执行；判不出结论时返回 null。
 * 形状与 `ToolExecutor` 注入面用的 `KernelToolLoopGuardApi` 同源，这里把它挪到类上方当本类的接口。
 */
export interface KernelToolLoopGuardApi extends KernelToolLoopGuardContract {}

class KernelToolLoopGuard implements KernelToolLoopGuardApi {
  private readonly progress = new ExecutionProgress()
  public recordOutcome(input: Parameters<ExecutionProgress['record']>[0]): string | undefined { return this.progress.record(input) }

  private lastWriteSuccess: Nullable<{ key: string; count: number }> = null
  private lastFailureBatchKey: Nullable<string> = null
  private lastFailureBatchCount = 0

  public checkRepeatedWriteLikeSuccess(input: KernelToolLoopGuardInput): Nullable<string> {
    if (!input.writeLike) return null

    const key = buildSuccessKey(input)
    const count = this.lastWriteSuccess?.key === key ? this.lastWriteSuccess.count : 0
    if (count < 2) return null

    return `工具 "${input.toolName}" 用同一组参数已经成功过 2 次。别再重复这次写入，先看清当前状态再决定下一步。`
  }

  public recordSuccess(input: KernelToolLoopGuardInput): void {
    // 一次成功的检查或一次不同的写入都让 Agent 面对新的状态：只保留当前这一串连续写入，长运行下也有上限。
    if (!input.writeLike) {
      this.lastWriteSuccess = null
      return
    }

    const key = buildSuccessKey(input)
    this.lastWriteSuccess = {
      key,
      count: this.lastWriteSuccess?.key === key ? this.lastWriteSuccess.count + 1 : 1,
    }
  }

  public recordFailureBatch(
    batch: readonly KernelToolFailureBatchEntry[]
  ): Nullable<string> {
    if (isEmpty(batch)) {
      this.lastFailureBatchKey = null
      this.lastFailureBatchCount = 0
      return null
    }

    const key = buildFailureBatchKey(batch)
    if (key === this.lastFailureBatchKey) {
      this.lastFailureBatchCount += 1
    } else {
      this.lastFailureBatchKey = key
      this.lastFailureBatchCount = 1
    }

    if (this.lastFailureBatchCount < 3) return null

    return `同一批工具调用已经连续失败 3 次。别再原样重试，先查清失败原因，换一条修复路径。`
  }
}

export { isKernelWriteLikeTool, KernelToolLoopGuard }
