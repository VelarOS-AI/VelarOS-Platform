import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'

import {
  GameModId,
  GameSpaceId,
  GameToolNames,
  GameTurnContextSourceIds,
} from '../contracts.js'
import { gameTools } from '../tools/index.js'

export interface GameBundledModDefinition {
  readonly id: typeof GameModId
  readonly specifier: string
  readonly defaultEnabled: false
  readonly manifest: typeof GameAgentModManifest
  readonly bindings: {
    readonly tools: typeof gameTools
    readonly toolCategories: Readonly<Record<'game', ToolCategoryDefinition>>
  }
}

const GameToolCategory = Object.freeze<ToolCategoryDefinition>({
  id: 'game',
  label: 'Game',
  description: '声明式游戏工程编辑、运行、观察与输入验证。',
  toolOs: { domain: 'game', defaultState: 'loadable' },
})

const GameAgentModManifest = Object.freeze({
  id: GameModId,
  version: '0.1.0',
  publisher: 'VelarOS',
  displayName: 'VelarOS AI Game Engine',
  description: 'VelarOS 官方游戏工程空间、工具、运行态与回合上下文。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories', 'spaces', 'turnContextSources'],
  contributes: {
    toolCategories: [
      {
        id: 'game',
        label: GameToolCategory.label,
        description: GameToolCategory.description,
        order: 45,
      },
    ],
    tools: GameToolNames.map((name) => ({
      name,
      categoryId: 'game',
      availableInSpaces: [GameSpaceId],
    })),
    spaces: [
      {
        id: GameSpaceId,
        descriptor: {
          label: 'Game',
          hint: '编辑、运行并观察当前游戏工程',
          startTitle: '开始构建游戏',
          order: 40,
          localeKey: 'workspace.space.game',
        },
        iconId: 'game',
        identityStrategy: 'path',
        surfaceProfileId: 'game',
        boundCapabilityIds: ['velaros.game'],
        inheritsSpaceIds: ['project'],
        toolCategoryIds: ['game'],
        turnContextSourceIds: [...GameTurnContextSourceIds],
      },
    ],
    turnContextSources: GameTurnContextSourceIds.map((id, index) => ({
      id,
      label:
        id === 'game.runtime-errors'
          ? '游戏运行报错'
          : id === 'game.selection'
            ? '游戏实体选择'
            : '游戏场景状态',
      spaces: [GameSpaceId],
      rendererVisible: true,
      priority: 60 + index,
    })),
  },
})

/**
 * Host-neutral bundled pack payload. The product shell owns persistence and activation;
 * this package owns the manifest and runtime bindings.
 */
export function createGameBundledModDefinition(): GameBundledModDefinition {
  return Object.freeze({
    id: GameModId,
    specifier: `bundled:${GameModId}`,
    defaultEnabled: false,
    manifest: GameAgentModManifest,
    bindings: Object.freeze({
      tools: gameTools,
      toolCategories: Object.freeze({ game: GameToolCategory }),
    }),
  })
}
