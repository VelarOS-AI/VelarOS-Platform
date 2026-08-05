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
  /*
   * `turnContextSources` 刻意**不在** requiredAxes 里。
   *
   * requiredAxes 答的是「宿主接不住这条轴就别装我」（fail-closed，不做残废激活）。游戏空间的
   * 三条回合上下文源今天由产品壳自己的空间描述表投递，本 mod 的 `contributes.turnContextSources`
   * 还没有宿主落点——真按 required 写，宿主如实收缩 supportedAxes 之后整个 game mod 会被拒载，
   * 而它的工具与空间明明照常工作。声明保留（接线即生效），但它不是本 mod 的生存条件。
   */
  requiredAxes: ['tools', 'toolCategories', 'spaces'],
  contributes: {
    toolCategories: [
      {
        id: 'game',
        label: GameToolCategory.label,
        description: GameToolCategory.description,
        order: 45,
      },
    ],
    // 游戏工具一共六个，整族就是「编辑—运行—看—输入」的主回路，全部常驻；
    // 这里不做二次分档，避免为了省两个 schema 逼模型每次先 map 一轮。
    tools: GameToolNames.map((name) => ({
      name,
      categoryId: 'game',
      availableInSpaces: [GameSpaceId],
      residentInSpaces: [GameSpaceId],
    })),
    // 只声明**真被消费**的那几格（身份策略 / 绑定能力 / 配方继承 / 职责类别）。空间的文案、
    // 图标、顺序、surface 分档与回合上下文源白名单权威都在产品壳的枚举表：manifest 里那份
    // `descriptor.label='Game'` 与壳里的「游戏开发」从来就不是一句话，而且没有任何读者。
    spaces: [
      {
        id: GameSpaceId,
        identityStrategy: 'path',
        boundCapabilityIds: ['velaros.game'],
        inheritsSpaceIds: ['project'],
        toolCategoryIds: ['game'],
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
