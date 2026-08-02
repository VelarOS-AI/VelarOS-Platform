import type { ToolCategoryDefinition } from '@velaros-ai/core/types'

import { browserTools } from '../tools/Collection'

const BrowserModId = 'velaros.browser' as const
const BrowserSpaceId = 'browser' as const

const BrowserToolCategory = Object.freeze<ToolCategoryDefinition>({
  id: 'browser',
  label: 'Browser',
  description: '浏览器页面读取、交互与会话控制。',
  toolOs: { domain: 'browser', defaultState: 'resident' },
})

const BrowserAgentModManifest = Object.freeze({
  id: BrowserModId,
  version: '0.2.6',
  publisher: 'VelarOS',
  displayName: 'VelarOS Browser',
  description: '浏览器空间与浏览器职责工具。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories', 'spaces'],
  contributes: {
    toolCategories: [{
      id: BrowserToolCategory.id,
      label: BrowserToolCategory.label,
      description: BrowserToolCategory.description,
      order: 20,
    }],
    tools: Object.keys(browserTools).map((name) => ({
      name,
      categoryId: 'browser',
      residentInSpaces: [BrowserSpaceId],
    })),
    spaces: [{
      id: BrowserSpaceId,
      descriptor: {
        label: 'Browser',
        hint: '浏览并操作网页',
        startTitle: '开始浏览',
        order: 30,
        localeKey: 'workspace.space.browser',
      },
      iconId: 'browser',
      identityStrategy: 'origin',
      surfaceProfileId: 'browser-control',
      boundCapabilityIds: [BrowserModId],
    }],
  },
})

interface BrowserBundledModDefinition {
  readonly id: typeof BrowserModId
  readonly specifier: string
  readonly defaultEnabled: true
  readonly manifest: typeof BrowserAgentModManifest
  readonly bindings: {
    readonly tools: typeof browserTools
    readonly toolCategories: Readonly<Record<'browser', ToolCategoryDefinition>>
  }
}

function createBrowserBundledModDefinition(): BrowserBundledModDefinition {
  return Object.freeze({
    id: BrowserModId,
    specifier: `bundled:${BrowserModId}`,
    defaultEnabled: true,
    manifest: BrowserAgentModManifest,
    bindings: Object.freeze({
      tools: browserTools,
      toolCategories: Object.freeze({ browser: BrowserToolCategory }),
    }),
  })
}

export {
  BrowserModId,
  BrowserSpaceId,
  BrowserToolCategory,
  createBrowserBundledModDefinition,
}
export type { BrowserBundledModDefinition }
