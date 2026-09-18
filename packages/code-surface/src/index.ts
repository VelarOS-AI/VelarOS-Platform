/** 根入口：给 Node 宿主用；起隔离进程、跑 TypeScript 检查，都要 Node。 */

export type { CodeSurfaceErrorCode, CodeSurfaceToolName } from './contract/constants.js'
export { ApprovalNamespace, CodeSurfaceDiagnosticCodes, CodeSurfaceErrorCodes, CodeSurfaceKernelModuleVersion, CodeSurfaceLimits, CodeSurfaceModId, CodeSurfaceToolCategoryId, CodeSurfaceToolNames } from './contract/constants.js'
export type { CodeSurfaceCapabilityService, CodeSurfaceTool, CodeSurfaceToolCollection } from './contract/provides.js'
export type {
  CodeCapabilityCall,
  CodeCapabilityOutcome,
  CodeCapabilityPort,
  CodeRunnerApi,
  CodeSurfaceEventSink,
  CodeSurfaceSpacePort,
  CodeSurfaceToolContext,
  CodeSurfaceToolContextResolver,
  CreateCodeSurfaceKernelModuleOptions,
} from './contract/requires.js'
export { createCapabilityPort } from './impl/CapabilityOperationPort.js'
export type { CodeProgramCheckerApi } from './impl/CodeProgramChecker.js'
export { codeProgramChecker } from './impl/CodeProgramChecker.js'
export type { CodeProgramGateApi } from './impl/CodeProgramGate.js'
export { createCodeProgramGate } from './impl/CodeProgramGate.js'
export type { CodeSurfaceSessionApi } from './impl/CodeSurfaceSession.js'
export { createCodeSurfaceSession } from './impl/CodeSurfaceSession.js'
export { CodeSurfaceCapability, codeSurfaceTools, createCodeSurfaceKernelModule } from './impl/CodeSurfaceTools.js'
export { nodeSubprocessCodeRunner,NodeSubprocessRunnerIsReleaseReady } from './impl/NodeSubprocessCodeRunner.js'
export type {
  CapabilityLease,
  CapabilityModuleSurface,
  CodeAttachment,
  CodeCallNotice,
  CodeProgramCheckFailure,
  CodeProgramCheckResult,
  CodeProgramCheckSuccess,
  CodeProgramDiagnostic,
  CodeProgramEdit,
  CodeProgramFailure,
  CodeProgramRange,
  CodeProgramRequest,
  CodeProgramResult,
  CodeSurfaceOutcome,
  CompletedCall,
  GrantedModule,
  MountedCapabilityModule,
  ProgramImport,
} from './types/code-surface.js'
export type { CodeGateReply, CodeGateRunInput } from './types/gate.js'
export type {
  CapabilityNamespaceOperations,
  CapabilityOperation,
  CapabilityOperationContext,
  CapabilityOperationTable,
} from './types/operations.js'
export type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest, HoldProgramClock } from './types/runner.js'
