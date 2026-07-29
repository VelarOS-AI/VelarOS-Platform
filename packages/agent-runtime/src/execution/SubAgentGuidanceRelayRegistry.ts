import { isBlank, isEmpty } from '@velaros-ai/core'
interface SubAgentGuidanceRelayWorkerSnapshot {
  threadId: string
  title: string
  description: Nullable<string>
  prompt: string
  agentName: string
  subagentType: string
}

interface SubAgentGuidanceRelayWorkerHandle {
  consumeRelayedGuidance: () => Nullable<string>
  enqueueRelayedGuidance: (message: string) => void
  abortSignal: AbortSignal
  abort: (reason?: string) => void
}

interface RegisterSubAgentGuidanceRelayWorkerInput extends SubAgentGuidanceRelayWorkerSnapshot {
  executionId: string
}

interface ActiveSubAgentGuidanceRelayWorker extends SubAgentGuidanceRelayWorkerSnapshot {
  relayQueue: string[]
  abortController: AbortController
}

/**
 * 跟踪单次 execution 内正在运行的子 Agent，并为运行中引导 relay 提供 FIFO 队列。
 */
class SubAgentGuidanceRelayRegistry {
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

    return worker.relayQueue.shift() ?? null
  }
}

export { SubAgentGuidanceRelayRegistry }
export type {
  RegisterSubAgentGuidanceRelayWorkerInput,
  SubAgentGuidanceRelayWorkerHandle,
  SubAgentGuidanceRelayWorkerSnapshot,
}
