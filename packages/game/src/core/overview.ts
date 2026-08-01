import { isPresent, toNullable } from '@velaros-ai/core'

import type { GameManifestDocument } from './editor.js'
import { parseGameProjectManifestText, parseGameSceneManifestText } from './manifest-parser.js'
import { gameReferenceId } from './references.js'

/**
 * 一份场景清单的**只读摘要**——给宿主界面看的，不参与任何编辑或运行判定。
 *
 * `entityCount` 是清单里直接写着的实体条数（含 `remove` 墓碑），不做继承解析：
 * 解析后的实体数只有运行时才算得准，而运行时自己有 `query({select:'scene'})`。
 * 两个数字各有出处，混起来会得到一个「哪儿都对不上」的第三个数。
 */
export interface GameSceneOverview {
  readonly id: string
  readonly path: string
  readonly title: Nullable<string>
  readonly entityCount: number
}

/**
 * 游戏工程的**只读摘要**：宿主舞台在「没跑起来」时唯一能诚实展示的东西。
 *
 * 全部字段都来自磁盘上的清单文本，没有一个是编出来的缺省值——读不出来的场景进
 * {@link unreadableScenePaths}，而不是被当成「零实体的场景」混进 {@link scenes}。
 */
export interface GameProjectOverview {
  readonly name: string
  readonly canvas: { readonly width: number; readonly height: number }
  readonly pixelArt: boolean
  /** 入口场景 id（已从 `scene:<id>` 引用里剥出来）；工程没声明入口就是 null。 */
  readonly entrySceneId: Nullable<string>
  readonly scenes: readonly GameSceneOverview[]
  /** 工程声明了、但清单读不出来（缺席 / 坏 JSON / 不合 schema）的场景路径。 */
  readonly unreadableScenePaths: readonly string[]
  readonly prefabCount: number
  readonly assetsPath: string
  /** dev server 命令；工程没写就是运行时的同一份缺省值，不是本函数编的。 */
  readonly devCommand: string
  readonly devPort: number
}

/**
 * dev server 的缺省命令与端口 —— **运行时与摘要共用这一份**。
 *
 * 住在 core 而不是 runtime，是因为依赖方向只允许 runtime → core：让 `GameDevServerController`
 * 从这里取，摘要也从这里取，界面说的「会跑什么」与真跑的才是同一件事。各写一份的那一版，
 * 改端口缺省时必然漏掉另一处。
 */
export const GameDefaultDevCommand = 'bun run dev'
export const GameDefaultDevPort = 5173

/**
 * 把工程清单 + 场景清单文本读成一份界面可直接渲染的摘要。
 *
 * 解析不通过（工程清单坏了）返回 null——**不回半份摘要**：宿主拿到 null 时说的是
 * 「这个目录不是可读的游戏工程」，拿到对象时每个字段都可信。
 */
export function summarizeGameProject(input: {
  readonly projectText: string
  readonly sceneDocuments: readonly GameManifestDocument[]
}): Nullable<GameProjectOverview> {
  let project
  try {
    project = parseGameProjectManifestText(input.projectText).value
  } catch {
    // arch-guard:silent-catch-ok 工程清单不可读时整份摘要缺席，由宿主按「不是游戏工程」渲染。
    return null
  }

  const documentsByPath = new Map(
    input.sceneDocuments.map((document) => [document.path, document] as const)
  )
  const scenes: GameSceneOverview[] = []
  const unreadableScenePaths: string[] = []
  for (const path of project.scenes) {
    const document = documentsByPath.get(path)
    if (!document) {
      unreadableScenePaths.push(path)
      continue
    }
    try {
      const scene = parseGameSceneManifestText(document.text, path).value
      scenes.push({
        id: scene.id,
        path,
        title: toNullable(scene.meta?.title),
        entityCount: scene.entities.length,
      })
    } catch {
      // arch-guard:silent-catch-ok 单份场景坏掉只让它自己进不可读清单，不拖垮整份摘要。
      unreadableScenePaths.push(path)
    }
  }

  return {
    name: project.name,
    canvas: {
      width: project.runtime.canvas.width,
      height: project.runtime.canvas.height,
    },
    pixelArt: project.runtime.pixelArt,
    entrySceneId: isPresent(project.entryScene) ? gameReferenceId(project.entryScene) : null,
    scenes,
    unreadableScenePaths,
    prefabCount: project.prefabs.length,
    assetsPath: project.assets,
    devCommand: project.dev.server?.command ?? GameDefaultDevCommand,
    devPort: project.dev.server?.port ?? GameDefaultDevPort,
  }
}
