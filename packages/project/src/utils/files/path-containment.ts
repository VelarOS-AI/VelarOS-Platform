/**
 * 路径约束：路径在不在项目根里。词法判断给宿主与工具算相对路径；FileStore 的准入门还要沿符号链接解析，挡住经软链逃出工作区。
 */
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isEmpty, isNotNull } from '@velaros-ai/core'

import type { ProjectPathPlatform } from '../../types/files.js'
import { ProjectError } from '../errors.js'
import { isInsideRoot } from '../path.js'

/**
 * 把路径解析到「最近一个真实存在的祖先」的 realpath，再把尚不存在的尾巴拼回去。
 *
 * 为什么不能直接 `realpath(abs)`：写入路径在检查时通常还不存在（create_file），realpath 会
 * 直接抛 ENOENT——那样要么放行未检查的路径（失败方向不安全），要么写不了新文件。逐级上溯
 * 保证「祖先目录里有软链指向 root 外」也能被下面的根内判定抓到。
 */
export async function realPathPreservingMissing(absPath: string): Promise<string> {
  let current = resolve(absPath)
  let tail = ''
  while (true) {
    try {
      return resolve(await realpath(current), tail)
    } catch {
      // arch-guard:silent-catch-ok 路径可能尚未存在；继续向上寻找可 realpath 的祖先。
      const parent = dirname(current)
      if (parent === current) return resolve(absPath)
      tail = tail ? join(basename(current), tail) : basename(current)
      current = parent
    }
  }
}

/** 路径连同还不存在的尾巴按 realpath 解析后必须仍在真实根目录里，否则按 PERMISSION_DENIED 拒绝：挡的是经符号链接逃出工作区。 */
export async function assertConfinedToRoot(
  realRoot: string,
  abs: string,
  inputPath: string,
): Promise<void> {
  const realTarget = await realPathPreservingMissing(abs)
  if (isInsideRoot(realRoot, realTarget)) return
  throw new ProjectError(
    'PERMISSION_DENIED',
    `路径解析后越出工作区根目录：${inputPath}`,
    { inputPath },
    '该路径或其祖先通过符号链接指向当前工作区外部。请切换到目标包的真实工作区，或只检查当前工作区源码；不要改搜该路径的父目录。',
  )
}

const defaultPlatform: ProjectPathPlatform = { isAbsolute, relative, resolve, sep }

/** 候选路径在项目根里时返回相对根的路径（根本身是 '.'），不在返回 null；只按字面判断，不解析符号链接。 */
export function getRelativePathInsideProjectRoot(
  rootPath: string,
  candidatePath: string,
  platform: ProjectPathPlatform = defaultPlatform,
): Nullable<string> {
  const relativePath = platform.relative(
    platform.resolve(rootPath),
    platform.resolve(candidatePath),
  )
  const inside =
    isEmpty(relativePath) ||
    relativePath === '.' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${platform.sep}`) &&
      !platform.isAbsolute(relativePath))
  return inside ? relativePath || '.' : null
}

/** 候选路径在不在项目根里（按字面判断）。 */
export function isPathInsideProjectRoot(
  rootPath: string,
  candidatePath: string,
  platform?: ProjectPathPlatform,
): boolean {
  return isNotNull(getRelativePathInsideProjectRoot(rootPath, candidatePath, platform))
}

/** 把相对路径里的反斜杠换成 /，各平台写法一致。 */
export function toPortableProjectRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}
