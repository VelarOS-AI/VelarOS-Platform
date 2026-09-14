// Agent Host 仅看到精简的 `project:*` 项目能力面，事务阶段留在领域内部。
export { executeProjectCode, executeProjectCodeAnalysis, executeProjectCodeIndex } from '../code/query'
export { legacyProjectTools } from '../compatibility/agent-tools'
export { migrateProjectReusedInput, ProjectInputContractVersion, projectInputReuseSourceTools } from '../compatibility/input-migration'
export { ProjectCodeSchema } from '../project-code-contracts'
export type {
  ProjectCodeIndexQuery,
  ProjectCodeLanguageQuery,
  ProjectCodeQuery,
} from '../project-code-query.js'
export { finalizeProjectModelResult } from './presentation/source-window'
export * from './Project.tool'
export { registerProjectFileContext } from './ProjectFileContext'
export * from './ProjectKernelPort'
export { createProjectCodeAnalysisTools, projectCodeAnalysisTools } from './tools/code-analysis'
export { executeProjectRead } from './tools/read'
export type {
  ProjectAuthorizationDecision,
  ProjectToolApi,
  ProjectToolContext,
  ProjectToolSystemApi,
} from './Types'
