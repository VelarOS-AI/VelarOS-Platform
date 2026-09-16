/** 工具入参的公共处理：三个知识工具都要先落到一个确定的工作区根上。 */

import { isBlank } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { KnowledgeToolContext } from '../contract/requires.js'

/** 定下这次调用用哪个工作区根：入参优先，其次宿主当前激活的；两个都没有就报校验错误。 */
export async function resolveWorkspaceRoot(
  inputWorkspaceRoot: LooseOptional<string>,
  ctx: KnowledgeToolContext
): Promise<string> {
  const workspaceRoot = inputWorkspaceRoot?.trim()
    || (ctx.hasProjectRoot() ? ctx.project.getRootPath() : '')
  if (isBlank(workspaceRoot)) {
    throw new AppError('VALIDATION', '需要提供 workspaceRoot，或先激活当前工作区。')
  }

  return workspaceRoot
}
