import type {
  ExecutionEventRecord,
  ExecutionRecord,
  ExecutionTaskRecord,
} from '@velaros-ai/agent/protocol'

type AppendExecutionEventInput = Omit<
  ExecutionEventRecord,
  'id' | 'executionId' | 'timestamp'
> & {
  timestamp?: number
}

interface ExecutionTaskLedgerStore {
  require(executionId: string): ExecutionRecord
  updateTask(
    executionId: string,
    taskId: string,
    updater: (task: ExecutionTaskRecord) => ExecutionTaskRecord
  ): ExecutionRecord
  appendEvent(executionId: string, input: AppendExecutionEventInput): ExecutionEventRecord
  emitDebug(executionId: string): void
}

interface ExecutionAgentEventLedgerStore {
  get(executionId: string): Nullable<ExecutionRecord>
  require(executionId: string): ExecutionRecord
  appendEvent(executionId: string, input: AppendExecutionEventInput): ExecutionEventRecord
}

export type {
  AppendExecutionEventInput,
  ExecutionAgentEventLedgerStore,
  ExecutionTaskLedgerStore,
}
