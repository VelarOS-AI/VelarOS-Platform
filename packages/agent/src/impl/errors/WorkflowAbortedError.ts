import { AgentErrorCodes } from '../../contract/constants.js'

export class WorkflowAbortedError extends Error {
  public readonly code = AgentErrorCodes.workflowAborted
}
