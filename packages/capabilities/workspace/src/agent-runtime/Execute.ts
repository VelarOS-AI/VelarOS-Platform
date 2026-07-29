import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { isEmpty,isString } from '@velaros-ai/core'

import { isShellCommandReadOnly } from '../command-execution-policy.js'
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
  if (isSameOrChild(currentRoot, targetPath)) return false

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
        isSameOrChild(entry.path, targetPath)
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

export function isSameOrChild(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(targetPath))
  return (
    isEmpty(relativePath) ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  )
}
