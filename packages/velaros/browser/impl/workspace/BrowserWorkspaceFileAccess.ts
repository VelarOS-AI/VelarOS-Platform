import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import { isNotNull, isNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserFileLimits } from '../../contract/constants'
import type {
  BrowserSiteContext,
  ProjectReadFileResult,
  WorkspaceFileEntry,
  WorkspaceListOptions,
  WorkspaceWriteFileOptions,
  WorkspaceWriteFileResult,
} from '../../types/browser.js'
import type { BrowserWorkspaceResolvedPath } from '../../types/workspace.js'
import { clampInteger } from '../../utils/numbers.js'
import { BrowserTuning } from '../../utils/tuning'
import { readResolvedFile } from '../../utils/workspace-paths'
import { isMissingFileError } from '../../utils/workspace-paths'
import { ensureRoot } from '../../utils/workspace-paths'
import { resolveExistingPathInRoot } from '../../utils/workspace-paths'
import { normalizeRelativePath } from '../../utils/workspace-paths'
import { collectRootEntries } from '../../utils/workspace-paths'
import {
  getRelativePathInsideRoot,
  resolveBrowserWorkspacePath,
} from '../../utils/workspace-paths.js'

/**
 * 为浏览器制品提供直接文件访问。
 *
 * 浏览器快照、方案和提取结果属于运行时制品，不是模型写入的工作区编辑。
 * 这个适配器把它们限制在浏览器工作区根目录下，不经过工作区编辑事务和改动行策略。
 */
export interface BrowserWorkspaceFileAccessApi {
  /**
   * 列当前站点工作区内的文件，按条数与递归深度收口。
   */
  listFiles(options?: WorkspaceListOptions): Promise<WorkspaceFileEntry[]>
  /** 读站点工作区里的一个文件；不给上限时最多读到约定的字符上限。 */
  readFile(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ): Promise<ProjectReadFileResult>
  /** 同时接受相对路径和当前站点根内的绝对路径，供 Host 预览已有 browser artifact。 */
  readWorkspacePath(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ): Promise<ProjectReadFileResult>
  /** 往站点工作区写一个二进制文件。 */
  writeBinaryFile(
    path: string,
    content: Buffer,
    options?: WorkspaceWriteFileOptions
  ): Promise<WorkspaceWriteFileResult>
  /** 往站点工作区写一个文本文件。 */
  writeFile(
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ): Promise<WorkspaceWriteFileResult>
  /** 删除工作区内的普通文件；拒绝目录、符号链接与越界路径。 */
  deleteFile(path: string): Promise<{ path: string; deleted: boolean }>
}

class BrowserWorkspaceFileAccess implements BrowserWorkspaceFileAccessApi {
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot)
  }

  public async listFiles(options: WorkspaceListOptions = {}): Promise<WorkspaceFileEntry[]> {
    const recursive = !!options.recursive
    const limit = clampInteger(
      options.limit,
      1,
      BrowserFileLimits.listItems,
      BrowserTuning.lists.workspaceFiles
    )
    const maxDepth = clampInteger(
      options.maxDepth,
      0,
      BrowserFileLimits.listDepth,
      recursive ? BrowserTuning.lists.workspaceDepth : 1
    )
    const entries: WorkspaceFileEntry[] = []
    await collectRootEntries({
      workspaceRoot: this.workspaceRoot,
      path: options.path ?? '.',
      recursive,
      limit,
      maxDepth,
      entries,
    })

    return entries
  }

  public async readFile(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ): Promise<ProjectReadFileResult> {
    const target = await resolveExistingPathInRoot(this.workspaceRoot, path)
    return readResolvedFile(target, path, startLine, endLine, maxChars)
  }

  /** 同时接受相对路径和当前站点根内的绝对路径，供 Host 预览已有 browser artifact。 */
  public async readWorkspacePath(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ): Promise<ProjectReadFileResult> {
    if (!isAbsolute(path)) return this.readFile(path, startLine, endLine, maxChars)

    if (!getRelativePathInsideRoot(this.workspaceRoot, resolve(path)))
      throw new AppError('PERMISSION', '只能预览当前网站浏览器工作区内的文件。', undefined, {
        path,
      })
    const root = await ensureRoot(this.workspaceRoot)
    const existing = await realpath(path).catch((error: any) => {
      if (isMissingFileError(error)) {
        throw new AppError('NOT_FOUND', '找不到浏览器工作区文件。', error, {
          path,
        })
      }
      throw error
    })
    const relativePath = getRelativePathInsideRoot(root, existing)
    if (!relativePath) {
      throw new AppError('PERMISSION', '只能读取当前网站浏览器工作区内的文件。', undefined, {
        path,
      })
    }
    return readResolvedFile({ path: existing, root }, path, startLine, endLine, maxChars)
  }

  public async writeBinaryFile(
    path: string,
    content: Buffer,
    options?: WorkspaceWriteFileOptions
  ): Promise<WorkspaceWriteFileResult> {
    const target = await this.resolveWritablePath(path)
    const existing = await lstat(target.path).catch((error: any) => {
      if (isMissingFileError(error)) return null
      throw error
    })

    if (isNotNull(existing) && !options?.overwrite) {
      throw new AppError('VALIDATION', '浏览器工作区文件已存在。', undefined, {
        path,
      })
    }

    await writeFile(target.path, content)

    return {
      path: target.path,
      bytes: content.byteLength,
      created: isNull(existing),
      changed: true,
    }
  }

  public async writeFile(
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ): Promise<WorkspaceWriteFileResult> {
    const target = await this.resolveWritablePath(path)
    const existing = await readFile(target.path, 'utf8').catch((error: any) => {
      if (isMissingFileError(error)) return null
      throw error
    })

    if (isNotNull(existing) && !options?.overwrite) {
      throw new AppError('VALIDATION', '浏览器工作区文件已存在。', undefined, {
        path,
      })
    }

    await writeFile(target.path, content, 'utf8')

    return {
      path: target.path,
      bytes: Buffer.byteLength(content, 'utf8'),
      created: isNull(existing),
      changed: existing !== content,
    }
  }

  /** 删除工作区内的普通文件；拒绝目录、符号链接与越界路径。 */
  public async deleteFile(path: string): Promise<{ path: string; deleted: boolean }> {
    const target = await resolveExistingPathInRoot(this.workspaceRoot, path)
    const existing = await lstat(target.path).catch((error: any) => {
      if (isMissingFileError(error)) return null
      throw error
    })
    if (!existing) return { path: target.path, deleted: false }
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new AppError('VALIDATION', '浏览器工作区只能删除普通文件。', undefined, { path })
    }

    await unlink(target.path)
    return { path: target.path, deleted: true }
  }

  private async resolveWritablePath(path: string): Promise<BrowserWorkspaceResolvedPath> {
    const root = await ensureRoot(this.workspaceRoot)
    const relativePath = normalizeRelativePath(path)
    // 建目录本身也有副作用：先解开现有祖先的链接并核对边界，再创建已确认在根内的目录。
    const candidate = await resolveBrowserWorkspacePath(root, relativePath, '浏览器工作区写入路径')
    await mkdir(dirname(candidate.path), { recursive: true })
    const target = await resolveBrowserWorkspacePath(root, relativePath, '浏览器工作区写入路径')

    const existingStats = await lstat(target.literalPath).catch((error: any) => {
      if (isMissingFileError(error)) return null
      throw error
    })
    if (existingStats?.isSymbolicLink()) {
      throw new AppError('PERMISSION', '浏览器工作区不能写入符号链接。', undefined, { path })
    }

    return { path: target.path, root }
  }
}

/** 按一个工作区根建文件访问器。 */
function createBrowserWorkspaceFileAccess(workspaceRoot: string): BrowserWorkspaceFileAccessApi {
  return new BrowserWorkspaceFileAccess(workspaceRoot)
}

/** 直接按当前站点上下文建文件访问器。 */
function createBrowserSiteWorkspaceFileAccess(
  context: Pick<BrowserSiteContext, 'workspaceRoot'>
): BrowserWorkspaceFileAccessApi {
  return new BrowserWorkspaceFileAccess(context.workspaceRoot)
}

export { createBrowserSiteWorkspaceFileAccess, createBrowserWorkspaceFileAccess }
