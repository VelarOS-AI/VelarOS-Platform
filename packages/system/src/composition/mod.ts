import type { ToolCategoryDefinition } from '@velaros-ai/core/types'

import {
  systemDesktopTools,
  systemExecutionTools,
  systemFileTools,
  systemProcessTools,
  systemTools,
} from '../Collection'
import { SystemToolNames } from '../system-tool-names'

const SystemModId = 'velaros.system' as const
const SystemSpaceId = 'system' as const

const SystemToolCategories = Object.freeze({
  'system-files': Object.freeze<ToolCategoryDefinition>({
    id: 'system-files',
    label: 'System files',
    description: '显式系统路径下的有界文件操作。',
    toolOs: { domain: 'system', defaultState: 'resident' },
  }),
  'system-execution': Object.freeze<ToolCategoryDefinition>({
    id: 'system-execution',
    label: 'System execution',
    description: '项目根之外受治理的系统命令。',
    toolOs: { domain: 'system', defaultState: 'resident' },
  }),
  'system-processes': Object.freeze<ToolCategoryDefinition>({
    id: 'system-processes',
    label: 'System processes',
    description: '系统进程与后台任务管理。',
    toolOs: { domain: 'system', defaultState: 'resident' },
  }),
  'system-desktop': Object.freeze<ToolCategoryDefinition>({
    id: 'system-desktop',
    label: 'System desktop',
    description: '跨平台桌面打开操作。',
    toolOs: { domain: 'system', defaultState: 'resident' },
  }),
})

const SystemCategoryTools = Object.freeze({
  'system-files': systemFileTools,
  'system-execution': systemExecutionTools,
  'system-processes': systemProcessTools,
  'system-desktop': systemDesktopTools,
})

function systemCategoryForTool(name: string): keyof typeof SystemCategoryTools {
  for (const [categoryId, tools] of Object.entries(SystemCategoryTools))
    if (Object.hasOwn(tools, name)) return categoryId as keyof typeof SystemCategoryTools
  throw new Error(`System tool「${name}」没有职责类别。`)
}

const SystemAgentModManifest = Object.freeze({
  id: SystemModId,
  version: '1.0.0',
  publisher: 'VelarOS',
  displayName: 'VelarOS System',
  description: '系统空间的文件、执行、进程与桌面职责包。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories', 'spaces'],
  contributes: {
    toolCategories: Object.values(SystemToolCategories).map((category, order) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      order: 10 + order,
    })),
    tools: Object.values(SystemToolNames).map((name) => ({
      name,
      categoryId: systemCategoryForTool(name),
      residentInSpaces: [SystemSpaceId],
    })),
    spaces: [{
      id: SystemSpaceId,
      descriptor: {
        label: 'System',
        hint: '操作本机文件、进程与桌面资源',
        startTitle: '开始系统任务',
        order: 10,
        localeKey: 'workspace.space.system',
      },
      iconId: 'system',
      identityStrategy: 'ordinal',
      surfaceProfileId: 'chat',
      boundCapabilityIds: [SystemModId],
    }],
  },
})

interface SystemBundledModDefinition {
  readonly id: typeof SystemModId
  readonly specifier: string
  readonly defaultEnabled: true
  readonly manifest: typeof SystemAgentModManifest
  readonly bindings: {
    readonly tools: typeof systemTools
    readonly toolCategories: typeof SystemToolCategories
  }
}

function createSystemBundledModDefinition(): SystemBundledModDefinition {
  return Object.freeze({
    id: SystemModId,
    specifier: `bundled:${SystemModId}`,
    defaultEnabled: true,
    manifest: SystemAgentModManifest,
    bindings: Object.freeze({ tools: systemTools, toolCategories: SystemToolCategories }),
  })
}

export {
  createSystemBundledModDefinition,
  SystemModId,
  SystemSpaceId,
  SystemToolCategories,
}
export type { SystemBundledModDefinition }
