import { AgentErrorCodes } from '../../contract/constants.js'

export class WorkflowBudgetExhaustedError extends Error {
  public readonly code = AgentErrorCodes.workflowBudgetExhausted
}
