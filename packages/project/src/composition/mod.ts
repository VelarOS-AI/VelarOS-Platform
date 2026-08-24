import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'

import {
  projectChangeTools,
  projectCodeTools,
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
  'development-code': Object.freeze<ToolCategoryDefinition>({
    id: 'development-code',
    label: 'Code intelligence',
    description: '项目内置的代码符号、引用、依赖、诊断与影响面查询。',
    toolOs: { domain: 'project', defaultState: 'resident' },
  }),
})

/**
 * 项目空间的常驻工具：读—找—改—跑这条主回路，写码会话每轮都在用。
 *
 * `project:rollback` 是事故通道（真出事了再从 `tooling:map` 按名换入），不占每轮 schema。
 */
const ProjectResidentToolNames = new Set<string>([
  ProjectToolNames.read,
  ProjectToolNames.list,
  ProjectToolNames.search,
  ProjectToolNames.queryCode,
  ProjectToolNames.edit,
  ProjectToolNames.write,
  ProjectToolNames.run,
])

const ProjectCategoryTools = Object.freeze({
  'project-files': projectFileTools,
  'project-changes': projectChangeTools,
  'project-execution': projectExecutionTools,
  'development-code': projectCodeTools,
})

function projectCategoryForTool(name: string): keyof typeof ProjectCategoryTools {
  for (const [categoryId, tools] of Object.entries(ProjectCategoryTools))
    if (Object.hasOwn(tools, name)) return categoryId as keyof typeof ProjectCategoryTools
  throw new Error(`Project tool「${name}」没有职责类别。`)
}

const ProjectAgentModManifest = Object.freeze({
  id: ProjectModId,
  version: '2.0.3',
  publisher: 'VelarOS',
  displayName: 'VelarOS Project',
  description: '项目空间的文件、代码理解、变更与执行职责包。',
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
      availableInSpaces: [ProjectSpaceId],
      ...(ProjectResidentToolNames.has(name) ? { residentInSpaces: [ProjectSpaceId] } : {}),
    })),
    // 只声明**真被消费**的那几格（身份策略 / 绑定能力 / 职责类别）。空间的文案、图标、
    // 顺序与 surface 分档权威在产品壳的枚举表，manifest 里再写一份没有读者，只会让人
    // 改了 manifest 却什么都没变。理由与 browser mod 同一条，别再补回来。
    spaces: [{
      id: ProjectSpaceId,
      identityStrategy: 'path',
      boundCapabilityIds: [ProjectModId],
      toolCategoryIds: Object.keys(ProjectToolCategories),
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
