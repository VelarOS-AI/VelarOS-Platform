/** 可移植入口：只有数据形状与常量表，不碰 Node，渲染进程也能加载。 */

export type { CodeSurfaceErrorCode, CodeSurfaceToolName } from './contract/constants.js'
export { CodeSurfaceDiagnosticCodes, CodeSurfaceErrorCodes, CodeSurfaceKernelModuleVersion, CodeSurfaceLimits, CodeSurfaceModId, CodeSurfaceToolCategoryId, CodeSurfaceToolNames } from './contract/constants.js'
export { createCapabilityPort } from './impl/CapabilityOperationPort.js'
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
  CodeProgramRequest,
  CodeProgramResult,
  CodeSurfaceOutcome,
  CompletedCall,
  GrantedModule,
  MountedCapabilityModule,
  ProgramImport,
} from './types/code-surface.js'
export type {
  CapabilityNamespaceOperations,
  CapabilityOperation,
  CapabilityOperationContext,
  CapabilityOperationTable,
} from './types/operations.js'
