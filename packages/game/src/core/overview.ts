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
  /**
   * 工程**声明**的 dev server 命令；**null = 走宿主内置静态服务**。
   *
   * 这一格从「string + 缺省 `bun run dev`」改成 Nullable 是 2026-08-01 判决的直接后果：
   * 缺省不再是一条命令，而是「宿主起一份自带运行时的静态服务」。留着旧缺省会让摘要说一句
   * 运行时根本不会执行的话——而界面说的与真跑的分叉，正是上一批花了整整一节去修的病。
   */
  readonly devCommand: Nullable<string>
  /** 声明的端口；内置服务用内核分配的临时端口，开跑前不存在这个数字，故为 null。 */
  readonly devPort: Nullable<number>
}

/**
 * 工程声明了 `dev.server.command` 却没写端口时的缺省端口 —— **运行时与摘要共用这一份**。
 *
 * 住在 core 而不是 runtime，是因为依赖方向只允许 runtime → core：让 `GameDevServerController`
 * 从这里取，摘要也从这里取，界面说的「会跑在哪」与真跑的才是同一件事。
 *
 * **没有 `GameDefaultDevCommand` 了**：命令缺席不再回落到一条命令，而是换一条运行路径
 * （内置静态服务）。留一个「缺省命令」常量在这里，等于给两条路之间又造一个会漂的中间态。
 */
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
    // 声明了命令才有「端口」可谈：内置服务那条路两格都是 null，界面据此说「宿主内置服务」。
    devCommand: toNullable(project.dev.server?.command),
    devPort: isPresent(project.dev.server?.command)
      ? (project.dev.server?.port ?? GameDefaultDevPort)
      : null,
  }
}
