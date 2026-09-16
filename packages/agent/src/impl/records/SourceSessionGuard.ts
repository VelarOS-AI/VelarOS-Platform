/**
 * 来源作用域上的执行互斥：一个作用域同一时刻只留一个活跃执行，新执行开始就把旧的 abort 掉。
 * 作用域键由上层定，可以是 sessionId，也可以是 `{sessionId, resourceContextId}` 拼出来的组合键。
 *
 * 状态只在内存里（作用域 → 活跃执行 + AbortController + generation），进程重启即清空。
 * 实现是 `SourceSessionGuard`，执行服务持一份。
 */
export interface SourceSessionGuardApi {
  /** 登记一个新执行并挤掉同作用域的旧执行：旧执行的 AbortController 会以「运行被新的请求取代。」中断。返回新执行自己的 AbortController、递增后的 generation，以及被挤掉的那个 executionId（没有就是 null）。 */
  start(sourceScopeId: string, executionId: string): StartSourceSessionExecutionResult
  /** 用户按停止时中断这个作用域的活跃执行，返回被中断的 executionId；作用域上没有活跃执行时返回 null。`reason` 会传给 AbortController，模型侧看得到。 */
  abort(sourceScopeId: string, reason?: string): Nullable<string>
  /** 宿主级中断：把这个 source session 名下的活跃执行全部中断，返回被中断的 executionId 列表。 */
  abortAllForSourceSession(sourceSessionId: string, reason?: string): string[]
  /** 账号失效或进程进入安全停用态时，中断所有作用域的活跃执行，返回被中断的 executionId 列表。 */
  abortAll(reason?: string): string[]
  /** 执行收尾时清掉活跃标记：`generation` 与登记时拿到的那个对不上，说明自己早被新执行取代了，此时什么都不做并返回 false。 */
  finish(sourceScopeId: string, generation: number): boolean
  /** 这个作用域当前活跃的 executionId；没有活跃执行时返回 null。 */
  getActiveExecutionId(sourceScopeId: string): Nullable<string>
}

class SourceSessionGuard implements SourceSessionGuardApi {
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

import type { ActiveSourceSessionExecution, StartSourceSessionExecutionResult } from '../../types/records.js'

