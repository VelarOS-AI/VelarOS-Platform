import { createProjectCodeAnalysisTools } from '../agent/tools/code-analysis.js'
import type { ProjectToolContext } from '../agent/Types.js'
import { PROJECT_PACKAGE_VERSION } from '../runtime/defaults.js'

/** Independent optional contribution; its schema is not part of the default Project surface. */
export function createProjectCodeAnalysisContribution(isAvailable: (context: ProjectToolContext) => boolean) {
  return Object.freeze({
    id: 'velaros.project.code-analysis',
    version: PROJECT_PACKAGE_VERSION,
    manifest: {
      id: 'velaros.project.code-analysis',
      version: PROJECT_PACKAGE_VERSION,
      publisher: 'VelarOS',
      displayName: 'Project code analysis',
      description: '按需代码图分析扩展。',
      manifestSchemaVersion: 1,
      engines: { velaros: '*', agent: '*' },
      trust: 'bundled-official',
      requiredAxes: ['tools'],
      contributes: { tools: [{ name: 'project:code-analysis', categoryId: 'development-code', availableInSpaces: ['project'] }] },
    },
    bindings: { tools: createProjectCodeAnalysisTools(isAvailable) },
  })
}
