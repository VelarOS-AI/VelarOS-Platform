/**
 * 项目给共用能力装的端口（`impl/operations/ProjectCapabilityPorts.ts`）要的判定：路径钳在项目内（按真实路径）、换成相对项目根的写法，
 * 以及把项目内核的拒绝翻成跨空间共用的通用码。
 */

import { resolve } from 'node:path'

import { isNull, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { currentPlatform } from '@velaros-ai/platform'

/** 项目内核的原因码对应到通用码：看图说的是跨空间共用的那一套码（PERMISSION、NOT_FOUND……）。 */
const AppCodeOfReason: Readonly<Record<string, string>> = Object.freeze({
  PERMISSION_DENIED: 'PERMISSION',
  TARGET_NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'VALIDATION',
  NOT_SUPPORTED: 'VALIDATION',
})

/**
 * 把项目内核抛的拒绝翻成通用码的错误：内核的错误带 `reason`（原因码）、`message` 与可选的 `suggestedNextAction`，按字段认，不认类；
 * 下一步照写进 message。认不出的错误原样抛回去。
 */
export function genericFailure(error: unknown): unknown {
  const failure = error as { reason?: unknown; message?: unknown; suggestedNextAction?: unknown }
  if (!isString(failure?.reason) || !isString(failure.message)) return error
  const next = isString(failure.suggestedNextAction) ? `\n下一步：${failure.suggestedNextAction}` : ''
  return new AppError(AppCodeOfReason[failure.reason] ?? 'VALIDATION', `${failure.message}${next}`, error)
}

/**
 * 把模型给的路径钳在项目之内，返回解析后的绝对路径。判定按**真实路径**算：只看字面时，
 * 项目里一个指向项目外的链接就能把读写引到项目外面去。
 */
export async function insideProject(root: string, requested: string, what: '文件' | '工作目录' | '沙箱的源目录'): Promise<string> {
  const resolved = resolve(root, requested)
  const inside = currentPlatform.isPathTextInside(await resolveRealPath(resolved), await resolveRealPath(root), { caseSensitive: true })
  if (!inside) {
    throw new AppError(
      'PERMISSION',
      `${what}必须在当前项目之内：${requested}（经符号链接指到项目外的也不行）；项目空间只碰项目里的东西，要碰外面的换系统空间`,
    )
  }
  return resolved
}

/**
 * 把模型给的文件路径定到项目里，交回相对项目根的写法（`/` 分隔，项目根本身是空串）：越出项目（含经符号链接指到外面的）抛 PERMISSION。
 * 项目根自己可能是符号链接（macOS 的 /var 就是 /private/var），模型给的绝对路径两种写法都认。
 */
export async function projectRelativePath(projectRoot: string, requested: string): Promise<string> {
  const root = resolve(projectRoot)
  const resolved = await insideProject(root, requested, '文件')
  for (const base of [root, await resolveRealPath(root)]) {
    const relative = currentPlatform.relativePathTextInside(resolved, base, { caseSensitive: true })
    if (!isNull(relative)) return relative === '.' ? '' : relative
  }
  return resolved
}
