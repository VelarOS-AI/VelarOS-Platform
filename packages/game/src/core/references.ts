import { z } from 'zod'

export const GameSlugPattern = /^(?=.*\p{L})[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u
export const GameProjectRelativePathPattern =
  /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*[:*?"<>|]).+$/u

export const GameSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    GameSlugPattern,
    '必须使用稳定的 kebab-case slug（如 player、enemy-slime-01），不能使用 GUID 或纯生成式编号。',
  )

export const GameProjectRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(
    GameProjectRelativePathPattern,
    '必须是使用正斜杠的可移植工程内相对路径，不能使用绝对路径、空段、. 或 ..。',
  )
  .refine(
    (value) => [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    }),
    '工程内相对路径不能包含控制字符。',
  )

/**
 * 工程内的固定目录布局。
 *
 * 住在这里（而不是 `core/index.ts`）是为了让**清单编辑器**也能引用它：编辑器要按稳定 id 推出
 * 新场景 / 新 prefab 的落点路径，而 `index.ts` 反过来 `export *` 编辑器，放在那边就是一条循环。
 * 对外可见的名字与位置不变（`index.ts` 经 `export *` 原样转出）。
 */
export const GameProjectDirectories = Object.freeze({
  assets: 'assets',
  prefabs: 'prefabs',
  scenes: 'scenes',
  source: 'src',
})

export type GameProjectDirectory =
  (typeof GameProjectDirectories)[keyof typeof GameProjectDirectories]

/**
 * `project.assets` 缺席时的落点 —— **解析器的缺省值与编辑器开出的落点必须是同一个字面量**。
 *
 * 这条路径过去在三处各写一遍（解析器的 `defaulted`、编辑器角色冲突提示里的「资产清单默认 …」、
 * 编辑器修复工程清单自指声明时的回落）。它正是 hardening §2「看着一样就复制、后来各改各的」
 * 那张墓碑表的形状：解析器一旦改了缺省，另外两处开出的药方就会把模型指到一条工程不认的路径上。
 */
export const GameDefaultAssetsManifestPath = `${GameProjectDirectories.assets}/assets.json`

/**
 * 清单路径 → 稳定 id（`scenes/main.scene.json` → `main`）。
 *
 * 两个消费者共用一份：解析器用它给缺 `id` 的场景/prefab 清单补上（真机第一手，见
 * `withIdFromSourceName`），编辑器用它判断一条**声明了却还不存在**的清单路径能不能自举出
 * 一份合法的空清单。文件名推不出合法 slug（`My Scene.json`、`01.json`）时回 null，
 * 由调用方各自决定报什么错——绝不硬编一个非法 id。
 */
export function gameManifestIdFromPath(path: string): Nullable<string> {
  const fileName = path.split('/').at(-1)
  if (!fileName) return null
  const stem = fileName
    .replace(/\.(?:prefab|scene)\.json$/u, '')
    .replace(/\.json$/u, '')
  if (!stem) return null
  return GameSlugSchema.safeParse(stem).success ? stem : null
}

export type GameReferenceKind = 'asset' | 'entity' | 'prefab' | 'scene'
export type GameReference<TKind extends GameReferenceKind = GameReferenceKind> =
  `${TKind}:${string}`

export function createGameReferenceSchema<TKind extends GameReferenceKind>(
  kind: TKind,
): z.ZodType<GameReference<TKind>> {
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^${kind}:[\\p{L}\\p{N}]+(?:-[\\p{L}\\p{N}]+)*$`, 'u'),
      `必须使用 ${kind}:<slug> 引用（如 ${kind}:player），不能使用 GUID 或数字句柄。`,
    ) as z.ZodType<GameReference<TKind>>
}

export function gameReferenceId(reference: GameReference): string {
  return reference.slice(reference.indexOf(':') + 1)
}
