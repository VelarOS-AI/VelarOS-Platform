import { isBlank, isEmpty,toNullable } from '@velaros-ai/core'

import type { ActiveSubAgentGuidanceRelayWorker,RegisterSubAgentGuidanceRelayWorkerInput, SubAgentGuidanceRelayWorkerHandle, SubAgentGuidanceRelayWorkerSnapshot } from '../../types/records.js'
/**
 * 子 Agent 登记簿：按 executionId 记住这一次执行里还在跑的子 Agent（线程），
 * 并给每个子 Agent 挂一条 FIFO 队列，用户在父会话里补的话可以中途转达给它。
 *
 * 全部状态都在内存里，随执行收尾（`clearExecution`）一起清掉；所有中断都走子 Agent 自己的 AbortController。
 * 实现是 `SubAgentGuidanceRelayRegistry`，执行服务持一份。
 */
export interface SubAgentGuidanceRelayRegistryApi {
  /** 登记一个刚起的子 Agent 线程，返回给调用方的句柄：取一条转达消息、塞一条转达消息、它的 abortSignal、以及主动中断它的函数。同一 threadId 重复登记会覆盖前一条。 */
  registerWorker(input: RegisterSubAgentGuidanceRelayWorkerInput): SubAgentGuidanceRelayWorkerHandle
  /** 子 Agent 跑完后注销它；该执行下一个不剩时把整张表也删掉。没登记过的直接忽略。 */
  unregisterWorker(executionId: string, threadId: string): void
  /** 这次执行里还在跑的子 Agent 快照（不含队列和 AbortController），给界面和模型看「现在有谁在跑」。 */
  listActiveWorkers(executionId: string): SubAgentGuidanceRelayWorkerSnapshot[]
  /** 往某个子 Agent 的转达队列里塞一句话：消息去掉首尾空白后为空、或这个子 Agent 已经不在登记簿里，都返回 false，表示没塞进去。 */
  enqueueRelay(executionId: string, threadId: string, message: string): boolean
  /** 中断某个子 Agent；它不存在或早已被中断过时返回 false。`reason` 会传进 AbortController。 */
  abortWorker(executionId: string, threadId: string, reason?: string): boolean
  /** 中断这次执行里所有还没被中断的子 Agent；登记簿本身不动，还能继续查。 */
  abortAll(executionId: string, reason?: string): void
  /** 执行收尾：先中断全部子 Agent，再把这次执行的整张登记表删掉。 */
  clearExecution(executionId: string): void
}

/**
 * 跟踪单次 execution 内正在运行的子 Agent，并为运行中引导 relay 提供 FIFO 队列。
 */
class SubAgentGuidanceRelayRegistry implements SubAgentGuidanceRelayRegistryApi {
  private readonly workersByExecutionId = new Map<
    string,
    Map<string, ActiveSubAgentGuidanceRelayWorker>
  >()

  public registerWorker(
    input: RegisterSubAgentGuidanceRelayWorkerInput
  ): SubAgentGuidanceRelayWorkerHandle {
    const workers = this.workersByExecutionId.get(input.executionId) ?? new Map()
    const abortController = new AbortController()
    const worker: ActiveSubAgentGuidanceRelayWorker = {
      threadId: input.threadId,
      title: input.title,
      description: input.description,
      prompt: input.prompt,
      agentName: input.agentName,
      subagentType: input.subagentType,
      relayQueue: [],
      abortController,
    }
    workers.set(input.threadId, worker)
    this.workersByExecutionId.set(input.executionId, workers)

    return {
      consumeRelayedGuidance: () => this.consumeRelay(input.executionId, input.threadId),
      enqueueRelayedGuidance: (message) =>
        this.enqueueRelay(input.executionId, input.threadId, message),
      abortSignal: abortController.signal,
      abort: (reason) => abortController.abort(reason),
    }
  }

  public unregisterWorker(executionId: string, threadId: string): void {
    const workers = this.workersByExecutionId.get(executionId)
    if (!workers) return

    workers.delete(threadId)
    if (workers.size === 0) {
      this.workersByExecutionId.delete(executionId)
    }
  }

  public listActiveWorkers(executionId: string): SubAgentGuidanceRelayWorkerSnapshot[] {
    const workers = this.workersByExecutionId.get(executionId)
    if (!workers || workers.size === 0) return []

    return [...workers.values()].map((worker) => ({
      threadId: worker.threadId,
      title: worker.title,
      description: worker.description,
      prompt: worker.prompt,
      agentName: worker.agentName,
      subagentType: worker.subagentType,
    }))
  }

  public enqueueRelay(executionId: string, threadId: string, message: string): boolean {
    const normalized = message.trim()
    if (isBlank(normalized)) return false

    const worker = this.workersByExecutionId.get(executionId)?.get(threadId)
    if (!worker) return false

    worker.relayQueue.push(normalized)
    return true
  }

  public abortWorker(executionId: string, threadId: string, reason?: string): boolean {
    const worker = this.workersByExecutionId.get(executionId)?.get(threadId)
    if (!worker || worker.abortController.signal.aborted) return false

    worker.abortController.abort(reason)
    return true
  }

  public abortAll(executionId: string, reason?: string): void {
    const workers = this.workersByExecutionId.get(executionId)
    if (!workers) return

    for (const worker of workers.values()) {
      if (!worker.abortController.signal.aborted) {
        worker.abortController.abort(reason)
      }
    }
  }

  public clearExecution(executionId: string): void {
    this.abortAll(executionId)
    this.workersByExecutionId.delete(executionId)
  }

  private consumeRelay(executionId: string, threadId: string): Nullable<string> {
    const worker = this.workersByExecutionId.get(executionId)?.get(threadId)
    if (!worker || isEmpty(worker.relayQueue)) return null

    return toNullable(worker.relayQueue.shift())
  }
}

export { SubAgentGuidanceRelayRegistry }
