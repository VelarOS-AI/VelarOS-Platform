interface ActiveSourceSessionExecution {
  /** 当前活跃 execution id。 */
  executionId: string
  /** 同一 session 每次 start 都递增，用于 finally 防串扰。 */
  generation: number
  /** 当前执行的取消控制器。 */
  abortController: AbortController
}

interface StartSourceSessionExecutionResult {
  /** 新执行的取消控制器。 */
  abortController: AbortController
  /** 新执行的 generation。 */
  generation: number
  /** 被取代的旧 execution id。 */
  supersededExecutionId: Nullable<string>
}

/**
 * 来源作用域执行互斥守卫。
 *
 * 同一个来源作用域同一时间只能有一个活跃执行；新执行开始时会中断旧执行。
 * 上层可把作用域设为 sessionId，也可设为 `{sessionId, resourceContextId}` 组合键。
 * generation 用来防止旧执行 finally 时清掉新执行的 active 状态。
 */
class SourceSessionGuard {
  /** 来源作用域 id -> 当前活跃执行。 */
  private readonly activeExecutions = new Map<string, ActiveSourceSessionExecution>()

  /** 开始新执行，并中断同作用域的旧执行。 */
  public start(sourceScopeId: string, executionId: string): StartSourceSessionExecutionResult {
    const current = this.activeExecutions.get(sourceScopeId)
    const generation = (current?.generation ?? 0) + 1

    // 新请求取代旧请求时，旧 abortController 会通知 Agent/工具停止。
    current?.abortController.abort('运行被新的请求取代。')

    const abortController = new AbortController()
    this.activeExecutions.set(sourceScopeId, {
      executionId,
      generation,
      abortController,
    })

    return {
      abortController,
      generation,
      supersededExecutionId: (toNullable(current?.executionId)),
    }
  }

  /** 用户主动停止当前作用域的活跃执行。 */
  public abort(sourceScopeId: string, reason = '用户停止了运行。'): Nullable<string> {
    const current = this.activeExecutions.get(sourceScopeId)
    if (!current) return null

    current.abortController.abort(reason)
    return current.executionId
  }

  /** 宿主级中断 source session 下的所有资源上下文执行。 */
  public abortAllForSourceSession(sourceSessionId: string, reason = '用户停止了运行。'): string[] {
    const abortedExecutionIds: string[] = []

    for (const [sourceScopeId, current] of this.activeExecutions.entries()) {
      if (sourceScopeId !== sourceSessionId) continue

      current.abortController.abort(reason)
      abortedExecutionIds.push(current.executionId)
    }

    return abortedExecutionIds
  }

  /** 账号失效或进程进入安全停用态时，中断全部来源作用域的活跃执行。 */
  public abortAll(reason = '系统停止了运行。'): string[] {
    const abortedExecutionIds: string[] = []
    for (const current of this.activeExecutions.values()) {
      current.abortController.abort(reason)
      abortedExecutionIds.push(current.executionId)
    }
    return abortedExecutionIds
  }

  /** 执行结束时清理 active 状态；generation 不匹配说明已经被新执行取代。 */
  public finish(sourceScopeId: string, generation: number): boolean {
    const current = this.activeExecutions.get(sourceScopeId)
    if (!current || current.generation !== generation) return false

    this.activeExecutions.delete(sourceScopeId)
    return true
  }

  /** 获取当前活跃 execution id。 */
  public getActiveExecutionId(sourceScopeId: string): Nullable<string> {
    return toNullable(this.activeExecutions.get(sourceScopeId)?.executionId)
  }
}

export { SourceSessionGuard }
import { toNullable } from '@velaros-ai/core'

