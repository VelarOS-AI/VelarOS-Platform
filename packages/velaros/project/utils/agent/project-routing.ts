import { isAbsolute } from 'node:path'

import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import type { ProjectOperationContext } from '../../contract/requires.js'
import { ProjectError } from '../errors.js'

/** 模型指定根只作路由请求；未配置宿主授权口时拒绝，原内核根内保护不变。 */
export async function resolveProjectContext(
  input: { projectRoot?: string },
  ctx: ProjectOperationContext,
  write: boolean
): Promise<ProjectOperationContext> {
  ctx.abortSignal.throwIfAborted()
  const root = input?.projectRoot
  if (root === undefined) return ctx
  if (typeof root !== 'string' || !isAbsolute(root))
    throw new ProjectError('INVALID_INPUT', 'projectRoot 必须是项目绝对路径')
  if (!ctx.resolveProject) throw new ProjectError('PERMISSION_DENIED', '宿主未提供跨项目授权入口')
  const project = await ctx.resolveProject(root, { write, signal: ctx.abortSignal })
  ctx.abortSignal.throwIfAborted()
  const requested = await resolveRealPath(root)
  const actual = await resolveRealPath(project.getRootPath())
  if (requested !== actual)
    throw new ProjectError('PERMISSION_DENIED', '授权项目根与请求的真实根不一致')
  return { ...ctx, project }
}
