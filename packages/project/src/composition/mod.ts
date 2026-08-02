import type { ToolCategoryDefinition } from '@velaros-ai/core/types'

import {
  projectChangeTools,
  projectExecutionTools,
  projectFileTools,
  projectTools,
} from '../agent/Project.tool.js'
import { ProjectToolNames } from '../project-tool-names.js'

const ProjectModId = 'velaros.project' as const
const ProjectSpaceId = 'project' as const

const ProjectToolCategories = Object.freeze({
  'project-files': Object.freeze<ToolCategoryDefinition>({
    id: 'project-files',
    label: 'Project files',
    description: '项目边界内的读取、列举与正文搜索。',
    toolOs: { domain: 'project', defaultState: 'resident' },
  }),
  'project-changes': Object.freeze<ToolCategoryDefinition>({
    id: 'project-changes',
    label: 'Project changes',
    description: '项目边界内的原子编辑与回滚。',
    toolOs: { domain: 'project', defaultState: 'resident' },
  }),
  'project-execution': Object.freeze<ToolCategoryDefinition>({
    id: 'project-execution',
    label: 'Project execution',
    description: '项目边界内受治理的命令执行。',
    toolOs: { domain: 'project', defaultState: 'resident' },
  }),
})

const ProjectCategoryTools = Object.freeze({
  'project-files': projectFileTools,
  'project-changes': projectChangeTools,
  'project-execution': projectExecutionTools,
})

function projectCategoryForTool(name: string): keyof typeof ProjectCategoryTools {
  for (const [categoryId, tools] of Object.entries(ProjectCategoryTools))
    if (Object.hasOwn(tools, name)) return categoryId as keyof typeof ProjectCategoryTools
  throw new Error(`Project tool「${name}」没有职责类别。`)
}

const ProjectAgentModManifest = Object.freeze({
  id: ProjectModId,
  version: '2.0.0',
  publisher: 'VelarOS',
  displayName: 'VelarOS Project',
  description: '项目空间的文件、变更与执行职责包。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories', 'spaces'],
  contributes: {
    toolCategories: Object.values(ProjectToolCategories).map((category, order) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      order: 30 + order,
    })),
    tools: Object.values(ProjectToolNames).map((name) => ({
      name,
      categoryId: projectCategoryForTool(name),
      residentInSpaces: [ProjectSpaceId],
    })),
    spaces: [{
      id: ProjectSpaceId,
      descriptor: {
        label: 'Project',
        hint: '阅读、修改并运行当前项目',
        startTitle: '打开项目',
        order: 20,
        localeKey: 'workspace.space.project',
      },
      iconId: 'project',
      identityStrategy: 'path',
      surfaceProfileId: 'chat',
      boundCapabilityIds: [ProjectModId],
    }],
  },
})

interface ProjectBundledModDefinition {
  readonly id: typeof ProjectModId
  readonly specifier: string
  readonly defaultEnabled: true
  readonly manifest: typeof ProjectAgentModManifest
  readonly bindings: {
    readonly tools: typeof projectTools
    readonly toolCategories: typeof ProjectToolCategories
  }
}

function createProjectBundledModDefinition(): ProjectBundledModDefinition {
  return Object.freeze({
    id: ProjectModId,
    specifier: `bundled:${ProjectModId}`,
    defaultEnabled: true,
    manifest: ProjectAgentModManifest,
    bindings: Object.freeze({ tools: projectTools, toolCategories: ProjectToolCategories }),
  })
}

export {
  createProjectBundledModDefinition,
  ProjectModId,
  ProjectSpaceId,
  ProjectToolCategories,
}
export type { ProjectBundledModDefinition }
