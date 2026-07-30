// 域：shell 执行前的「这条命令要不要先切/借工作区」判定。
//
// 跨层接缝：工具层（Execute.tool）只问"要不要弹授权"，本模块答"目标 cwd 在不在当前 root 内、
// 是不是一个已登记或看起来像项目的目录"。**根内判定统一走 `path-containment`**——这个包里
// 曾有三份逐字复制的 `isSameOrChild`，任一份漂移都会变成"某条路径悄悄免了授权"。
import { dirname, isAbsolute, resolve } from 'node:path'

import { isEmpty,isString } from '@velaros-ai/core'

import { isShellCommandReadOnly } from '../command-execution-policy.js'
import { isPathInsideWorkspaceRoot } from '../path-containment.js'
import { isProjectWorkspaceRootSource } from '../workspace-root-source.js'

import {
  type prepareWorkspaceMutation,
} from './Helpers'
import type { WorkspaceToolContext } from './Types'

export async function shouldPrepareCommandWorkspaceMutation(
  ctx: WorkspaceToolContext,
  command: string,
  cwd?: string
): Promise<boolean> {
  if (!cwd?.trim() || isShellCommandReadOnly(command)) return false

  return shouldPrepareExternalProjectMutation(ctx, cwd)
}

export async function shouldPrepareExternalProjectMutation(
  ctx: Parameters<typeof prepareWorkspaceMutation>[0],
  cwd?: string
): Promise<boolean> {
  if (!cwd?.trim()) return false

  const targetPath = resolveCommandCwd(ctx, cwd)
  const currentRoot = resolve(ctx.workspace.getRootPath())
  if (isPathInsideWorkspaceRoot(currentRoot, targetPath)) return false

  return (
    isKnownProjectWorkspacePath(ctx, targetPath) || (await isLikelyProjectDirectory(ctx, targetPath))
  )
}

export function resolveCommandCwd(ctx: WorkspaceToolContext, cwd: string): string {
  return isAbsolute(cwd) ? resolve(cwd) : resolve(ctx.workspace.getRootPath(), cwd)
}

export function isKnownProjectWorkspacePath(
  ctx: WorkspaceToolContext,
  targetPath: string
): boolean {
  return ctx.workspace
    .listRoots()
    .some(
      (entry) =>
        isProjectWorkspaceRootSource(entry.source) &&
        isString(entry.path) &&
        isPathInsideWorkspaceRoot(entry.path, targetPath)
    )
}

export async function isLikelyProjectDirectory(
  ctx: Parameters<typeof prepareWorkspaceMutation>[0],
  path: string
): Promise<boolean> {
  if (!ctx.system.discoverProjects) return false

  let currentPath = resolve(path)
  const rootPaths: string[] = []
  for (let depth = 0; depth < 6; depth += 1) {
    rootPaths.push(currentPath)

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  const projects = await ctx.system.discoverProjects({
    rootPaths,
    maxDepth: 0,
    limit: 1,
    refresh: true,
  })
  return !isEmpty(projects)
}
