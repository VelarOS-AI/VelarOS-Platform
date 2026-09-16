import type { ExecutionEventSeverity, ExecutionRecord, ExecutionTaskPlanStepStatus, ExecutionTaskRecord } from '../../types/agent.js'

class ExecRecordSeverity {
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
