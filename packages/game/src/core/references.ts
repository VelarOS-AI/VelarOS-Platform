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
