import { isBlank } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { KnowledgeTool } from '../../Types'

async function resolveWorkspaceRoot(
  inputWorkspaceRoot: LooseOptional<string>,
  ctx: Parameters<KnowledgeTool<Record<string, never>>['execute']>[1]
): Promise<string> {
  const workspaceRoot = inputWorkspaceRoot?.trim()
    || (ctx.hasProjectRoot() ? ctx.project.getRootPath() : '')
  if (isBlank(workspaceRoot)) {
    throw new AppError('VALIDATION', '需要提供 workspaceRoot，或先激活当前工作区。')
  }

  return workspaceRoot
}

export { resolveWorkspaceRoot }
