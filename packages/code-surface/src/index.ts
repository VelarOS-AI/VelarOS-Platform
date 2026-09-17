/** 根入口：给 Node 宿主用；起隔离进程、跑 TypeScript 检查，都要 Node。 */

export type { CodeSurfaceErrorCode } from './contract/constants.js'
export { CodeSurfaceErrorCodes, CodeSurfaceLimits, CodeSurfaceModId } from './contract/constants.js'
export type {
  CodeCapabilityCall,
  CodeCapabilityOutcome,
  CodeCapabilityPort,
  CodeRunnerApi,
  CodeSurfaceEventSink,
} from './contract/requires.js'
export type { CodeProgramCheckerApi } from './impl/CodeProgramChecker.js'
export { codeProgramChecker } from './impl/CodeProgramChecker.js'
export type { CodeSurfaceSessionApi } from './impl/CodeSurfaceSession.js'
export { createCodeSurfaceSession } from './impl/CodeSurfaceSession.js'
export { nodeSubprocessCodeRunner,NodeSubprocessRunnerIsReleaseReady } from './impl/NodeSubprocessCodeRunner.js'
export type {
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
} from './types/code-surface.js'
export type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from './types/runner.js'
