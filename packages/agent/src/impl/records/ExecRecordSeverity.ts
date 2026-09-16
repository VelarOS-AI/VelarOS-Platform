import type { ExecutionEventSeverity, ExecutionRecord, ExecutionTaskPlanStepStatus, ExecutionTaskRecord } from '../../types/agent.js'

/**
 * 状态到事件严重度的映射表：执行、任务、计划步骤各自的状态枚举，统一翻成账本事件的 `ExecutionEventSeverity`，
 * 界面按这个严重度上色、决定要不要弹提示。
 *
 * 无状态纯映射，`ExecutionRecords` 与 `ExecTaskLedger` 各持一份；每个分支都穷举，新增状态时 TypeScript 会在这里报缺分支。
 */
export interface ExecRecordSeverityApi {
  /** 一次执行的最终状态对应的严重度：completed=success，failed=error，aborted 与两种 awaiting_*=warning，pending/running=info。 */
  getExecutionStatusSeverity(status: ExecutionRecord['status']): ExecutionEventSeverity
  /** 执行里单个任务的状态对应的严重度，取值规则和执行状态一致。 */
  getTaskStatusSeverity(status: ExecutionTaskRecord['status']): ExecutionEventSeverity
  /** 任务计划里单个步骤的状态对应的严重度：completed=success，failed=error，skipped=warning，pending/delegated/running=info。 */
  getPlanStepStatusSeverity(status: ExecutionTaskPlanStepStatus): ExecutionEventSeverity
}

class ExecRecordSeverity implements ExecRecordSeverityApi {
  public getExecutionStatusSeverity(status: ExecutionRecord['status']): ExecutionEventSeverity {
    switch (status) {
      case 'completed':
        return 'success'
      case 'failed':
        return 'error'
      case 'aborted':
      case 'awaiting_confirmation':
      case 'awaiting_input':
        return 'warning'
      case 'pending':
      case 'running':
        return 'info'
    }
  }

  public getTaskStatusSeverity(status: ExecutionTaskRecord['status']): ExecutionEventSeverity {
    switch (status) {
      case 'completed':
        return 'success'
      case 'failed':
        return 'error'
      case 'aborted':
      case 'awaiting_confirmation':
      case 'awaiting_input':
        return 'warning'
      case 'pending':
      case 'running':
        return 'info'
    }
  }

  public getPlanStepStatusSeverity(status: ExecutionTaskPlanStepStatus): ExecutionEventSeverity {
    switch (status) {
      case 'completed':
        return 'success'
      case 'failed':
        return 'error'
      case 'skipped':
        return 'warning'
      case 'pending':
      case 'delegated':
      case 'running':
        return 'info'
    }
  }
}

export { ExecRecordSeverity, ExecRecordSeverity as ExecutionRecordSeverityHelper }
