/**
 * 路径约束：FileStore 的准入门沿符号链接解析路径，挡住经软链逃出工作区。
 *
 * 真实路径由 `@velaros-ai/core` 的 `resolveRealPath` 算：写入路径在检查时通常还不存在（create_file），
 * 它把路径解析到最近一个存在的祖先再把尚不存在的尾巴拼回去，「祖先目录里有软链指向 root 外」照样抓得到。
 */
import { resolve as resolvePath } from 'node:path'

import { isNull } from '@velaros-ai/core'
import { currentPlatform } from '@velaros-ai/core/platform'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import { ProjectError } from '../errors.js'
import { isInsideRoot } from '../path.js'

/** 一条已经解开符号链接的路径相对真实根的写法（`/` 分隔，根本身是 `.`）；不在根里返回 null。真实路径是盘上的写法，按字面比。 */
export function relativeInsideRealRoot(realRoot: string, realPath: string): Nullable<string> {
  const relative = currentPlatform.relativePathTextInside(realPath, realRoot, {
    caseSensitive: true,
  })
  return isNull(relative) || relative === '.' ? null : relative
}

/**
 * 把项目内的相对路径（或项目内的绝对路径）解析成绝对路径，并按解开符号链接后的真实路径核对它还在不在项目之内：
 * 只看字面时，项目里一个指向项目外的链接目录就能把边界绕过去。返回解析后的绝对路径、真实路径和判定结果，
 * 拒绝时的文字由调用方按用途给（沙箱源目录、命令工作目录各说各的）。
 */
export async function resolveInsideProject(
  rootPath: string,
  requested: string
): Promise<{ resolved: string; realPath: string; inside: boolean }> {
  const resolved = resolvePath(rootPath, requested)
  const realRoot = await resolveRealPath(rootPath)
  const realPath = await resolveRealPath(resolved)
  // 真实路径已经解开，按字面比（realpath 给出的就是盘上的写法）。
  return {
    resolved,
    realPath,
    inside: currentPlatform.isPathTextInside(realPath, realRoot, { caseSensitive: true }),
  }
}

/**
 * 路径连同还不存在的尾巴按 realpath 解析后必须仍在真实根目录里，否则按 PERMISSION_DENIED 拒绝：挡的是经符号链接逃出工作区。
 * 返回解开后的真实路径——同一个物理文件的别名（符号链接、大小写变体）解出来是同一条，策略判定按它算才不会被别名绕过。
 */
export async function resolveConfinedRealPath(
  realRoot: string,
  abs: string,
  inputPath: string
): Promise<string> {
  const realTarget = await resolveRealPath(abs)
  if (isInsideRoot(realRoot, realTarget)) return realTarget
  throw new ProjectError(
    'PERMISSION_DENIED',
    `路径经符号链接指到了项目外：${inputPath}`,
    { inputPath },
    '这个路径或它的某一层父目录经符号链接指到项目外，读不了：只看项目里的源码，或者请用户换到那个项目；不要改搜它的父目录。'
  )
}
