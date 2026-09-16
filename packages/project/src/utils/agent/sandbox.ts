/**
 * 执行类工具在项目空间的辅助：取宿主的沙箱端口、把沙箱源目录与命令工作目录限定在项目之内。落回前的核对与确认在 `@velaros-ai/rehearsal-sandbox`。
 */

import type { ProjectSandboxPort, ProjectToolContext } from '../../contract/requires.js'
import { ProjectError } from '../errors.js'
import { resolveInsideProject } from '../files/path-containment.js'

/** 宿主没接沙箱端口时这个工具不可用，也不出现在工具面上。 */
export function requireSandboxPort(context: ProjectToolContext): ProjectSandboxPort {
  const port = context.project.sandbox
  if (!port) throw new ProjectError('NOT_SUPPORTED', '当前宿主没有接入演练沙箱。', undefined,
    '这台机器上没有演练沙箱：要改一批文件就直接用 project:file、project:edit，要跑脚本用 project:run。')
  return port
}

/**
 * 把 source 解析成项目根之内的绝对路径；项目之外的目录拒绝——项目空间的沙箱只镜像项目。
 * 判定按解开符号链接后的真实路径算：只看字面时，项目里一个指向项目外的链接目录就能让宿主把外面的目录镜像进沙箱、
 * 落回时写到项目外。名字以 `..` 开头的目录（如 `..cache`）在项目之内，照常接受。
 */
export async function resolveSourceInsideProject(rootPath: string, source: LooseOptional<string>): Promise<string> {
  const requested = source ?? '.'
  const { resolved, realPath, inside } = await resolveInsideProject(rootPath, requested)
  if (!inside)
    throw new ProjectError(
      'PERMISSION_DENIED',
      `沙箱的源目录必须在当前项目之内：${requested}`,
      { path: requested, resolvedPath: realPath },
      '换一个项目之内的真实目录做源（经符号链接指到项目外的也不行）；要演练项目外的目录，用 system:sandbox。',
    )
  return resolved
}

/**
 * 把 project:run 的 cwd 解析成项目根之内的绝对路径：判定同样按解开符号链接后的真实路径算。
 * 排在命令分析、危险确认与修改授权之前，用户不会被问一条注定失败的命令。
 */
export async function resolveCommandCwdInsideProject(rootPath: string, cwd: LooseOptional<string>): Promise<string> {
  const requested = cwd ?? '.'
  const { resolved, realPath, inside } = await resolveInsideProject(rootPath, requested)
  if (!inside)
    throw new ProjectError(
      'PERMISSION_DENIED',
      `命令的工作目录必须在当前项目之内：${requested}`,
      { cwd: requested, resolvedPath: realPath },
      '换一个项目之内的目录（经符号链接指到项目外的也不行）；要在项目外跑命令，用系统空间的命令工具。',
    )
  return resolved
}
