/** 可移植入口：只有数据形状与常量表，不碰 Node，渲染进程也能加载。 */

export type { CodeSurfaceErrorCode } from './contract/constants.js'
export { CodeSurfaceErrorCodes, CodeSurfaceLimits, CodeSurfaceModId } from './contract/constants.js'
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
