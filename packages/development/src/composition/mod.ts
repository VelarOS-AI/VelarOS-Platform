import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'

import { DevelopmentToolNames, developmentTools } from '../Development.tool'

const DevelopmentModId = 'velaros.development' as const

const DevelopmentToolCategory = Object.freeze<ToolCategoryDefinition>({
  id: 'development-code',
  label: 'Code intelligence',
  description: '结构化代码符号、关系、依赖、诊断与影响面查询。',
  toolOs: { domain: 'development', defaultState: 'resident' },
})

const DevelopmentAgentModManifest = Object.freeze({
  id: DevelopmentModId,
  version: '1.0.0',
  publisher: 'VelarOS',
  displayName: 'VelarOS Development',
  description: '可组合进项目空间的代码理解职责包。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories'],
  contributes: {
    toolCategories: [{
      id: DevelopmentToolCategory.id,
      label: DevelopmentToolCategory.label,
      description: DevelopmentToolCategory.description,
      order: 33,
    }],
    tools: [{
      name: DevelopmentToolNames.queryCode,
      categoryId: DevelopmentToolCategory.id,
      availableInSpaces: ['project'],
    }],
  },
})

interface DevelopmentBundledModDefinition {
  readonly id: typeof DevelopmentModId
  readonly specifier: string
  readonly defaultEnabled: true
  readonly manifest: typeof DevelopmentAgentModManifest
  readonly bindings: {
    readonly tools: typeof developmentTools
    readonly toolCategories: Readonly<Record<'development-code', ToolCategoryDefinition>>
  }
}

function createDevelopmentBundledModDefinition(): DevelopmentBundledModDefinition {
  return Object.freeze({
    id: DevelopmentModId,
    specifier: `bundled:${DevelopmentModId}`,
    defaultEnabled: true,
    manifest: DevelopmentAgentModManifest,
    bindings: Object.freeze({
      tools: developmentTools,
      toolCategories: Object.freeze({ 'development-code': DevelopmentToolCategory }),
    }),
  })
}

export {
  createDevelopmentBundledModDefinition,
  DevelopmentModId,
  DevelopmentToolCategory,
}
export type { DevelopmentBundledModDefinition }
