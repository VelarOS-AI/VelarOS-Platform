// Agent Host 仅看到精简的 `project:*` 项目能力面，事务阶段留在领域内部。
export type {
  ProjectAuthorizationDecision,
  ProjectToolApi,
  ProjectToolContext,
  ProjectToolSystemApi,
} from '../contract/requires'
export * from '../impl/ProjectTools'
export { createProjectCodeAnalysisTools, projectCodeAnalysisTools } from '../impl/tools/code-analysis'
export { executeProjectCode, executeProjectCodeAnalysis, executeProjectCodeIndex } from '../impl/tools/code-query'
export { migrateProjectReusedInput, ProjectInputContractVersion, projectInputReuseSourceTools } from '../impl/tools/legacy-input-migration'
export { legacyProjectTools } from '../impl/tools/legacy-tools'
export { executeProjectRead } from '../impl/tools/read'
export { registerProjectFileContext } from '../utils/agent/file-context'
export * from '../utils/agent/kernel-port'
export { finalizeProjectModelResult } from '../utils/agent/source-window'
export { ProjectCodeSchema } from '../utils/schemas/code'
export type {
  ProjectCodeIndexQuery,
  ProjectCodeLanguageQuery,
  ProjectCodeQuery,
} from '../utils/schemas/code-query.js'
