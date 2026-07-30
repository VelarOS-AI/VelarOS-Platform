import { isAbsolute, resolve } from 'node:path'

import {isPlainObject, isPresent } from '@velaros-ai/core'

import { isPathInsideWorkspaceRoot } from '../path-containment.js'
import { isProjectWorkspaceRootSource } from '../workspace-root-source.js'

import type { VelaTool, WorkspaceAuthorizationDecision } from './Types'

/** coding 工具 execute 函数使用的上下文类型。 */
type CodingToolContext = Parameters<VelaTool<Record<string, never>>['execute']>[1]

/** 在可选 cwd 下执行工作区操作；未传 cwd 时使用当前 active root。 */
export async function runWithDirectory<T>(
  ctx: CodingToolContext,
  cwd: string | undefined,
  action: () => Promise<T>
): Promise<T> {
  if (!cwd) return action()

  const authorization = await prepareWorkspaceAccess(ctx, cwd)
  if (authorization) return buildWorkspaceMutationSkippedResult(authorization) as T

  // 在 runInDirectory 的 override context 内捕获实际根路径，
  // override 退出后 getRootPath() 会回到 activeRoot，所以必须在 callback 内捕获。
  let capturedRoot: Nullable<string> = null
  const wrappedAction = async (): Promise<T> => {
    capturedRoot = ctx.workspace.getRootPath()
    return action()
  }

  // runInDirectory 会临时切换工作区视角，action 结束后由 workspace 层恢复。
  const result = await ctx.workspace.runInDirectory(cwd, wrappedAction)

  // 把实际写入根路径注入结果，供 ToolResultEffectsHelper 提取 changedRoot。
  if (capturedRoot && isPresent(result) && isPlainObject(result)) {
    ;(result as Record<string, unknown>)._changedRoot = capturedRoot
  }

  return result
}

/** 工作区写操作被拒绝时的统一工具返回结构。 */
export function buildWorkspaceMutationSkippedResult(
  authorization: WorkspaceAuthorizationDecision
): Record<string, any> {
  return {
    approved: false,
    skipped: true,
    changed: false,
    rootPath: authorization.rootPath,
    authorizationScope: authorization.authorizationScope,
    rejectionMessage: authorization.rejectionMessage,
    message: authorization.message,
  }
}

/** 写入/删除/移动前统一请求工作区授权。 */
export async function prepareWorkspaceMutation(
  ctx: CodingToolContext,
  input: {
    cwd?: string
    operation: string
    targetPath?: LooseOptional<string>
    activate?: boolean
  }
): Promise<Nullable<WorkspaceAuthorizationDecision>> {
  const authorization = await ctx.workspace.prepareMutationWorkspace(input)
  return authorization.approved ? null : authorization
}

/** 显式 cwd 指向其它目录时，先进入该工作区；读操作可改用 read_any_file 免切换读取。 */
async function prepareWorkspaceAccess(
  ctx: CodingToolContext,
  cwd: string
): Promise<Nullable<WorkspaceAuthorizationDecision>> {
  const targetPath = isAbsolute(cwd) ? resolve(cwd) : resolve(ctx.workspace.getRootPath(), cwd)
  if (isPathInsideWorkspaceRoot(ctx.workspace.getRootPath(), targetPath)) return null

  const authorization = await ctx.workspace.prepareMutationWorkspace({
    cwd,
    operation: '通过显式 cwd 执行工作区工具',
  })
  return authorization.approved ? null : authorization
}

/** 判断当前是否有活动项目工作区。 */
function hasActiveProjectWorkspace(ctx: CodingToolContext): boolean {
  return ctx.workspace.listRoots().some((entry) =>
    entry.active && isProjectWorkspaceRootSource(entry.source)
  )
}

/** 没有活动项目工作区时隐藏 Git 类工具。 */
export function isGitToolAvailable(ctx: CodingToolContext): boolean {
  return hasActiveProjectWorkspace(ctx)
}
