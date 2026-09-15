/**
 * 演练沙箱在项目空间的辅助：取宿主的沙箱端口、把源目录限定在项目之内。落回前的核对与确认在 `@velaros-ai/rehearsal-sandbox`。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { ProjectSandboxPort, ProjectToolContext } from '../../contract/requires.js'

/** 宿主没接沙箱端口时这个工具不可用，也不出现在工具面上。 */
export function requireSandboxPort(context: ProjectToolContext): ProjectSandboxPort {
  const port = context.project.sandbox
  if (!port) throw new AppError('UNAVAILABLE', '当前宿主没有接入演练沙箱。')
  return port
}

/** 把 source 解析成项目根之内的绝对路径；项目之外的目录拒绝，项目空间的沙箱只镜像项目。名字以 .. 开头的目录（如 `..cache`）在项目之内，照常接受。 */
export function resolveSourceInsideProject(rootPath: string, source: LooseOptional<string>): string {
  const resolved = resolve(rootPath, source ?? '.')
  const inside = relative(rootPath, resolved)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new AppError('VALIDATION', `沙箱的源目录必须在当前项目之内：${source ?? '.'}`)
  return resolved
}
