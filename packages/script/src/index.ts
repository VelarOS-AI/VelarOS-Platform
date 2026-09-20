/** 根入口：给 Node 宿主用；起隔离进程、跑 TypeScript 检查，都要 Node。 */

export type { CodeSurfaceErrorCode } from './contract/constants.js'
export { CodeSurfaceDiagnosticCodes, CodeSurfaceErrorCodes, CodeSurfaceLimits } from './contract/constants.js'
export type {
  CodeCapabilityCall,
  CodeCapabilityOutcome,
  CodeCapabilityPort,
  CodeRunnerApi,
  CodeSurfaceEventSink,
} from './contract/requires.js'
export { createCapabilityPort } from './impl/CapabilityOperationPort.js'
export type { CodeProgramCheckerApi } from './impl/CodeProgramChecker.js'
export { codeProgramChecker } from './impl/CodeProgramChecker.js'
export type { CodeSurfaceSessionApi } from './impl/CodeSurfaceSession.js'
export { createCodeSurfaceSession } from './impl/CodeSurfaceSession.js'
export { nodeSubprocessCodeRunner,NodeSubprocessRunnerIsReleaseReady } from './impl/NodeSubprocessCodeRunner.js'
export type { CodeCallNotice, CodeProgramCheckFailure, CodeProgramCheckResult, CodeProgramCheckSuccess, CodeProgramDiagnostic, CodeProgramEdit, CodeProgramTargetEdit, CodeProgramEditResult, CodeProgramFailure, CodeProgramRequest, CodeProgramResult, CompletedCall, GrantedModule } from './types/script.js'
export type { CodeAttachment, CodeSurfaceOutcome } from './types/outcome.js'

export type {
  CapabilityNamespaceOperations,
  CapabilityOperation,
  CapabilityOperationContext,
  CapabilityOperationTable,
} from './types/operations.js'
export type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest, HoldProgramClock } from './types/runner.js'

export type { KernelScriptSessionOptions } from './contract/requires.js'
export type { KernelScriptSessionApi } from './contract/provides.js'
export { createKernelScriptSession } from './impl/KernelScriptSession.js'
export { CodeProgramEditLimits } from './contract/constants.js'
