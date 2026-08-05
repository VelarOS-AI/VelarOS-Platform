import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'

import { systemTools } from '../Collection'
import { SystemToolCategoryByName, SystemToolNames } from '../system-tool-names'

const SystemModId = 'velaros.system' as const
const SystemSpaceId = 'system' as const
/**
 * 系统空间的常驻工具：找—读—改—跑这条主回路。
 *
 * 进程、后台任务、环境刷新是排障与收尾场景，留在 loadable 由 `tooling:map` 按名换入。
 */
const SystemResidentToolNames = new Set<string>([
  SystemToolNames.read,
  SystemToolNames.list,
  SystemToolNames.search,
  SystemToolNames.edit,
  SystemToolNames.write,
  SystemToolNames.run,
])

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
      categoryId: SystemToolCategoryByName[name],
      availableInSpaces: [SystemSpaceId],
      ...(SystemResidentToolNames.has(name) ? { residentInSpaces: [SystemSpaceId] } : {}),
    })),
    // 只声明**真被消费**的那几格（身份策略 / 绑定能力 / 职责类别）。空间的文案、图标、
    // 顺序与 surface 分档权威在产品壳的枚举表，manifest 里再写一份没有读者。
    spaces: [{
      id: SystemSpaceId,
      identityStrategy: 'ordinal',
      boundCapabilityIds: [SystemModId],
      toolCategoryIds: Object.keys(SystemToolCategories),
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
