/** 可移植入口：只有数据形状与常量表，不碰 Node，渲染进程也能加载。 */
export type { CodeSurfaceErrorCode } from './contract/constants.js'
export {
  CodeSurfaceDiagnosticCodes,
  CodeSurfaceErrorCodes,
  CodeSurfaceLimits,
} from './contract/constants.js'
export { CodeProgramEditLimits } from './contract/constants.js'
export { ScriptOutputLimits } from './contract/constants.js'
export type { ScriptCompiledContract } from './types/compiler.js'
export type {
  NodeRuntimeEnvironment,
  NodeRuntimePackage,
  NodeRuntimePackageReference,
  NodeRuntimeSkill,
} from './types/environment.js'
export type {
  CapabilityNamespaceOperations,
  CapabilityOperation,
  CapabilityOperationContext,
  CapabilityOperationTable,
} from './types/operations.js'
export type { CodeAttachment, CodeSurfaceOutcome } from './types/outcome.js'
export type {
  ScriptExecutionMetrics,
  ScriptOutputBlock,
  ScriptOutputCapture,
  ScriptOutputConfig,
  ScriptOutputEdit,
  ScriptOutputFormat,
  ScriptOutputManifest,
  ScriptOutputOptions,
  ScriptOutputPresentation,
  ScriptOutputProjection,
  ScriptOutputSummary,
  ScriptOutputType,
  ScriptOutputView,
} from './types/output.js'
export type {
  CodeCallNotice,
  CodeProgramCheckFailure,
  CodeProgramCheckResult,
  CodeProgramCheckSuccess,
  CodeProgramDiagnostic,
  CodeProgramEdit,
  CodeProgramEditResult,
  CodeProgramFailure,
  CodeProgramRequest,
  CodeProgramResult,
  CodeProgramTargetEdit,
  CompletedCall,
  GrantedModule,
  ScriptModuleExportsSlice,
  ScriptModuleIndex,
} from './types/script.js'
export type { NodeProcessReceipt, NodeProcessRequest, NodeProcessResult } from './types/script.js'
