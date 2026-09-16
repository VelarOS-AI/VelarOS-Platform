/**
 * 演练沙箱在项目空间的辅助：取宿主的沙箱端口、把源目录限定在项目之内。落回前的核对与确认在 `@velaros-ai/rehearsal-sandbox`。
 */

import { resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { currentPlatform } from '@velaros-ai/platform'

import type { ProjectSandboxPort, ProjectToolContext } from '../../contract/requires.js'
import { ProjectError } from '../errors.js'

/** 宿主没接沙箱端口时这个工具不可用，也不出现在工具面上。 */
export function requireSandboxPort(context: ProjectToolContext): ProjectSandboxPort {
  const port = context.project.sandbox
  if (!port) throw new AppError('UNAVAILABLE', '当前宿主没有接入演练沙箱。')
  return port
}

/**
 * 把 source 解析成项目根之内的绝对路径；项目之外的目录拒绝——项目空间的沙箱只镜像项目。
 * 判定按解开符号链接后的真实路径算：只看字面时，项目里一个指向项目外的链接目录就能让宿主把外面的目录镜像进沙箱、
 * 落回时写到项目外。名字以 `..` 开头的目录（如 `..cache`）在项目之内，照常接受。
 */
export async function resolveSourceInsideProject(rootPath: string, source: LooseOptional<string>): Promise<string> {
  const requested = source ?? '.'
  const resolved = resolve(rootPath, requested)
  const realRoot = await resolveRealPath(rootPath)
  const realSource = await resolveRealPath(resolved)
  // 真实路径已经解开，按字面比（realpath 给出的就是盘上的写法）。
  if (!currentPlatform.isPathTextInside(realSource, realRoot, { caseSensitive: true }))
    throw new ProjectError(
      'PERMISSION_DENIED',
      `沙箱的源目录必须在当前项目之内：${requested}`,
      { path: requested, resolvedPath: realSource },
      '换一个项目之内的真实目录做源（经符号链接指到项目外的也不行）；要演练项目外的目录，用 system:sandbox。',
    )
  return resolved
}
