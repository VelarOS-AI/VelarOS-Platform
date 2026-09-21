/** 根入口：给 Node 宿主用；起隔离进程、跑 TypeScript 检查，都要 Node。 */

export type { CodeSurfaceErrorCode } from './contract/constants.js'
export { CodeSurfaceDiagnosticCodes, CodeSurfaceErrorCodes, CodeSurfaceLimits } from './contract/constants.js'
export { CodeProgramEditLimits } from './contract/constants.js'
export { ScriptOutputLimits } from './contract/constants.js'
export type { KernelScriptSessionApi } from './contract/provides.js'
export type { ScriptPackageCompilerApi } from './contract/provides.js'
export type {
  CodeCapabilityCall,
  CodeCapabilityOutcome,
  CodeCapabilityPort,
  CodeRunnerApi,
  CodeSurfaceEventSink,
} from './contract/requires.js'
export type { KernelScriptSessionOptions } from './contract/requires.js'
export { createCapabilityPort } from './impl/CapabilityOperationPort.js'
export type { CodeProgramCheckerApi } from './impl/CodeProgramChecker.js'
export { codeProgramChecker } from './impl/CodeProgramChecker.js'
export type { CodeSurfaceSessionApi } from './impl/CodeSurfaceSession.js'
export { createCodeSurfaceSession } from './impl/CodeSurfaceSession.js'
export { createKernelScriptSession } from './impl/KernelScriptSession.js'
export { nodeSubprocessCodeRunner,NodeSubprocessRunnerIsReleaseReady } from './impl/NodeSubprocessCodeRunner.js'
export type { ScriptOutputsApi } from './impl/ScriptOutputs.js'
export { scriptOutputs } from './impl/ScriptOutputs.js'
export { scriptPackageCompiler } from './impl/ScriptPackageCompiler.js'
export type {
  CapabilityNamespaceOperations,
  CapabilityOperation,
  CapabilityOperationContext,
  CapabilityOperationTable,
} from './types/operations.js'
export type { CodeAttachment, CodeSurfaceOutcome } from './types/outcome.js'
export type { ScriptExecutionMetrics, ScriptOutputBlock, ScriptOutputCapture, ScriptOutputConfig, ScriptOutputEdit, ScriptOutputManifest, ScriptOutputOptions, ScriptOutputPresentation, ScriptOutputProjection,ScriptOutputSummary, ScriptOutputType, ScriptOutputView } from './types/output.js'
export type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest, HoldProgramClock } from './types/runner.js'
export type { CodeCallNotice, CodeProgramCheckFailure, CodeProgramCheckResult, CodeProgramCheckSuccess, CodeProgramDiagnostic, CodeProgramEdit, CodeProgramEditResult, CodeProgramFailure, CodeProgramRequest, CodeProgramResult, CodeProgramTargetEdit, CompletedCall, GrantedModule } from './types/script.js'
export type { ScriptPackageDefinition, ScriptPackageSurface } from './types/script.js'
