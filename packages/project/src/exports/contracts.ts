/** 供渲染进程、Worker、RPC 与测试共用的可移植项目空间契约。 */
export type { ProjectToolName } from '../contract/constants.js'
export { ProjectToolNames } from '../contract/constants.js'
export { isProjectRootSource, ProjectRootSource } from '../impl/kernel/root-source.js'
export type * from '../types/project.js'
export type { ProjectCodeAnalysisInput, ProjectCodeInput } from '../types/tools.js'
export type {
  ProjectCodeIndexQuery,
  ProjectCodeLanguageAction,
  ProjectCodeLanguageQuery,
  ProjectCodeQuery,
  ProjectCodeQueryInput,
} from '../utils/schemas/code-query.js'
export {
  isProjectCodeLanguageQuery,
  ProjectCodeLanguageActions,
  ProjectCodeQuerySchema,
} from '../utils/schemas/code-query.js'
