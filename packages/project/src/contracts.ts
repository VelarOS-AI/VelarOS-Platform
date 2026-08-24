/** 供渲染进程、Worker、RPC 与测试共用的可移植项目空间契约。 */
export type {
  ProjectCodeIndexQuery,
  ProjectCodeLanguageAction,
  ProjectCodeLanguageQuery,
  ProjectCodeQuery,
  ProjectCodeQueryInput,
} from './project-code-query.js'
export {
  isProjectCodeLanguageQuery,
  ProjectCodeLanguageActions,
  ProjectCodeQuerySchema,
} from './project-code-query.js'
export type * from './project-contracts.js'
export { isProjectRootSource, ProjectRootSource } from './project-root-source.js'
export type { ProjectToolName } from './project-tool-names.js'
export { ProjectToolNames } from './project-tool-names.js'
