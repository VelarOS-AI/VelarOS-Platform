import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import { isEmpty, isNotNull, isNull, isObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { getRelativePathInsideRoot } from './BrowserPathContainment.js'
import type {
  BrowserSiteContext,
  ProjectReadFileResult,
  WorkspaceFileEntry,
  WorkspaceListOptions,
  WorkspaceWriteFileOptions,
  WorkspaceWriteFileResult,
} from './types.js'

const DefaultListLimit = 200
const DefaultListMaxDepth = 4
const MaxListLimit = 1000
const MaxListDepth = 16

interface BrowserWorkspaceResolvedPath {
  path: string
  root: string
}

function clampInteger(
  value: LooseOptional<number>,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback

  return Math.min(Math.max(Math.trunc(value as number), min), max)
}

function isMissingFileError(error: unknown): boolean {
  return isObject(error) && (error as { code?: unknown }).code === 'ENOENT'
}

function normalizeRelativePath(path: LooseOptional<string>): string {
  const value = path?.trim() || '.'
  if (isAbsolute(value)) {
    throw new AppError('PERMISSION', '浏览器工作区文件路径必须是相对路径。')
  }

  return value
}

/**
 * 为浏览器制品提供直接文件访问。
 *
 * 浏览器快照、方案和提取结果属于运行时制品，不是模型写入的工作区编辑。
 * 这个适配器把它们限制在浏览器工作区根目录下，不经过工作区编辑事务和改动行策略。
 */
class BrowserWorkspaceFileAccess {
  private readonly workspaceRoot: string
  /**
   * 只读的历史根，按新→旧排列。
   *
   * 站点资产从「按会话」换成「按站点」时不能把用户攒下的东西弄丢，也不该在启动路径上跑
   * 一次性搬迁（遍历全部会话目录、搬到一半失败比不搬更糟）。取而代之：**写只写主根，
   * 读不到才依次回退**。回退是幂等的，用户每碰一次旧资产就自然继续可用。
   */
  private readonly legacyWorkspaceRoots: readonly string[]

  constructor(
    workspaceRoot: string,
    legacyWorkspaceRoots: readonly string[] = [],
  ) {
    this.workspaceRoot = resolve(workspaceRoot)
    this.legacyWorkspaceRoots = legacyWorkspaceRoots.map((root) =>
      resolve(root),
    )
  }

  /** 主根 + 历史根，读路径按此顺序探测。 */
  private get readRoots(): readonly string[] {
    return [this.workspaceRoot, ...this.legacyWorkspaceRoots]
  }

  /**
   * 列目录：主根与历史根**取并集**，同名相对路径以主根为准。
   *
   * 只列主根会让「换粒度」在界面上等价于「资产没了」——制品面板是用户确认自己东西还在的
   * 唯一入口。上限按合并后的总数算，不给历史根额外配额。
   */
  public async listFiles(
    options: WorkspaceListOptions = {},
  ): Promise<WorkspaceFileEntry[]> {
    const recursive = !!options.recursive
    const limit = clampInteger(options.limit, 1, MaxListLimit, DefaultListLimit)
    const maxDepth = clampInteger(
      options.maxDepth,
      0,
      MaxListDepth,
      recursive ? DefaultListMaxDepth : 1,
    )
    const entries: WorkspaceFileEntry[] = []
    const seenRelativePaths = new Set<string>()

    for (const workspaceRoot of this.readRoots) {
      if (entries.length >= limit) break
      await this.collectRootEntries({
        workspaceRoot,
        path: options.path ?? '.',
        recursive,
        limit,
        maxDepth,
        entries,
        seenRelativePaths,
      })
    }

    return entries
  }

  private async collectRootEntries(input: {
    workspaceRoot: string
    path: string
    recursive: boolean
    limit: number
    maxDepth: number
    entries: WorkspaceFileEntry[]
    seenRelativePaths: Set<string>
  }): Promise<void> {
    const { entries, limit, maxDepth, recursive, seenRelativePaths } = input
    const target = await this.resolveExistingPathInRoot(
      input.workspaceRoot,
      input.path,
    ).catch(() => null)
    if (!target) return

    const targetStats = await stat(target.path).catch((error: any) => {
      if (isMissingFileError(error)) return null
      throw error
    })
    if (!targetStats) return

    const pushEntry = (
      entryPath: string,
      type: WorkspaceFileEntry['type'],
    ): boolean => {
      const relativePath = getRelativePathInsideRoot(target.root, entryPath)
      if (!relativePath || seenRelativePaths.has(relativePath)) return false
      seenRelativePaths.add(relativePath)
      entries.push({ path: entryPath, type })
      return true
    }

    if (targetStats.isFile()) {
      pushEntry(target.path, 'file')
      return
    }
    if (!targetStats.isDirectory()) return

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (entries.length >= limit) return

      const dirents = await readdir(directory, { withFileTypes: true }).catch(
        (error: any) => {
          if (isMissingFileError(error)) return []
          throw error
        },
      )
      dirents.sort((a, b) => a.name.localeCompare(b.name))

      for (const dirent of dirents) {
        if (entries.length >= limit) return
        if (dirent.isSymbolicLink()) {
          continue
        }

        const entryPath = resolve(directory, dirent.name)
        if (!getRelativePathInsideRoot(target.root, entryPath)) {
          continue
        }

        if (dirent.isDirectory()) {
          pushEntry(entryPath, 'directory')
          if (recursive && depth < maxDepth) {
            await visit(entryPath, depth + 1)
          }
        } else if (dirent.isFile()) {
          pushEntry(entryPath, 'file')
        }
      }
    }

    await visit(target.path, 1)
  }

  public async readFile(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number,
  ): Promise<ProjectReadFileResult> {
    const target = await this.resolveExistingPath(path)
    return this.readResolvedFile(target, path, startLine, endLine, maxChars)
  }

  private async readResolvedFile(
    target: BrowserWorkspaceResolvedPath,
    requestedPath: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number,
  ): Promise<ProjectReadFileResult> {
    const fileStats = await stat(target.path).catch((error: any) => {
      throw new AppError('NOT_FOUND', '找不到浏览器工作区文件。', error, {
        path: requestedPath,
      })
    })

    if (!fileStats.isFile()) {
      throw new AppError(
        'VALIDATION',
        '浏览器工作区路径必须指向文件。',
        undefined,
        {
          path: requestedPath,
        },
      )
    }

    const content = await readFile(target.path, 'utf8')
    const lines = content.split('\n')
    const totalLines = lines.length
    const safeStartLine = clampInteger(startLine, 1, Math.max(1, totalLines), 1)
    const safeEndLine = clampInteger(
      endLine,
      safeStartLine,
      Math.max(safeStartLine, totalLines),
      totalLines,
    )
    const rangedContent = lines.slice(safeStartLine - 1, safeEndLine).join('\n')
    const safeMaxChars =
      Number.isFinite(maxChars) && (maxChars as number) > 0
        ? Math.trunc(maxChars as number)
        : null
    const returnedContent =
      safeMaxChars && rangedContent.length > safeMaxChars
        ? rangedContent.slice(0, safeMaxChars)
        : rangedContent
    const truncated =
      returnedContent.length < rangedContent.length || safeEndLine < totalLines

    return {
      path: target.path,
      content: returnedContent,
      totalLines,
      startLine: safeStartLine,
      endLine: safeEndLine,
      totalChars: content.length,
      returnedChars: returnedContent.length,
      truncated,
      hasMore: truncated,
      remainingLines: Math.max(0, totalLines - safeEndLine),
      nextStartLine: safeEndLine < totalLines ? safeEndLine + 1 : null,
    }
  }

  /** 同时接受相对路径和当前站点根内的绝对路径，供 Host 预览已有 browser artifact。 */
  public async readWorkspacePath(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number,
  ): Promise<ProjectReadFileResult> {
    if (!isAbsolute(path))
      return this.readFile(path, startLine, endLine, maxChars)

    // 历史根也算「当前网站工作区」：制品面板列出来的旧资产带的是旧绝对路径，
    // 只认主根会让用户点开自己昨天存的快照时被判越权。
    const owningRoot = this.readRoots.find((root) =>
      getRelativePathInsideRoot(root, resolve(path)),
    )
    if (!owningRoot) {
      throw new AppError(
        'PERMISSION',
        '只能预览当前网站浏览器工作区内的文件。',
        undefined,
        {
          path,
        },
      )
    }
    const root = await this.ensureRoot(owningRoot)
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
      throw new AppError(
        'PERMISSION',
        '只能读取当前网站浏览器工作区内的文件。',
        undefined,
        {
          path,
        },
      )
    }
    return this.readResolvedFile(
      { path: existing, root },
      path,
      startLine,
      endLine,
      maxChars,
    )
  }

  public async writeBinaryFile(
    path: string,
    content: Buffer,
    options?: WorkspaceWriteFileOptions,
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
    options?: WorkspaceWriteFileOptions,
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
  public async deleteFile(
    path: string,
  ): Promise<{ path: string; deleted: boolean }> {
    // 历史根是只读兼容层；删除只允许命中主根，绝不能沿读回退删除旧资产。
    const target = await this.resolveExistingPathInRoot(
      this.workspaceRoot,
      path,
    )
    const existing = await lstat(target.path).catch((error: any) => {
      if (isMissingFileError(error)) return null
      throw error
    })
    if (!existing) return { path: target.path, deleted: false }
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new AppError(
        'VALIDATION',
        '浏览器工作区只能删除普通文件。',
        undefined,
        { path },
      )
    }

    await unlink(target.path)
    return { path: target.path, deleted: true }
  }

  /**
   * 在主根与历史根里依次找一份**已存在**的文件；都没有时按主根解析（错误信息指向新位置）。
   *
   * 只有读路径走这里。写路径永远只认主根：回退读是为了不丢旧资产，不是为了让写入分叉。
   */
  private async resolveExistingPathAcrossRoots(
    path: string,
  ): Promise<BrowserWorkspaceResolvedPath> {
    for (const root of this.legacyWorkspaceRoots) {
      const candidate = await this.resolveExistingPathInRoot(root, path).catch(
        () => null,
      )
      if (!candidate) continue
      const stats = await lstat(candidate.path).catch(() => null)
      if (stats) return candidate
    }

    return this.resolveExistingPathInRoot(this.workspaceRoot, path)
  }

  private async resolveExistingPath(
    path: string,
  ): Promise<BrowserWorkspaceResolvedPath> {
    const primary = await this.resolveExistingPathInRoot(
      this.workspaceRoot,
      path,
    )
    const primaryStats = await lstat(primary.path).catch(() => null)
    if (primaryStats || isEmpty(this.legacyWorkspaceRoots)) return primary

    return this.resolveExistingPathAcrossRoots(path)
  }

  private async resolveExistingPathInRoot(
    workspaceRoot: string,
    path: string,
  ): Promise<BrowserWorkspaceResolvedPath> {
    const root = await this.ensureRoot(workspaceRoot)
    const resolvedPath = this.resolveInsideRoot(root, path)
    const existingStats = await lstat(resolvedPath).catch((error: any) => {
      if (isMissingFileError(error)) return null
      throw error
    })
    if (existingStats?.isSymbolicLink()) {
      throw new AppError(
        'PERMISSION',
        '浏览器工作区不能读取符号链接。',
        undefined,
        { path },
      )
    }
    const realTarget = existingStats
      ? await realpath(resolvedPath)
      : resolvedPath

    if (!getRelativePathInsideRoot(root, realTarget)) {
      throw new AppError(
        'PERMISSION',
        '浏览器工作区文件路径不能离开当前站点目录。',
        undefined,
        {
          path,
        },
      )
    }

    return { path: realTarget, root }
  }

  private async resolveWritablePath(
    path: string,
  ): Promise<BrowserWorkspaceResolvedPath> {
    const root = await this.ensureRoot()
    const resolvedPath = this.resolveInsideRoot(root, path)
    await mkdir(dirname(resolvedPath), { recursive: true })

    const parentRealPath = await realpath(dirname(resolvedPath))
    if (!getRelativePathInsideRoot(root, parentRealPath)) {
      throw new AppError(
        'PERMISSION',
        '浏览器工作区写入路径不能离开当前站点目录。',
        undefined,
        {
          path,
        },
      )
    }

    const existingStats = await lstat(resolvedPath).catch((error: any) => {
      if (isMissingFileError(error)) return null
      throw error
    })
    if (existingStats?.isSymbolicLink()) {
      throw new AppError(
        'PERMISSION',
        '浏览器工作区不能写入符号链接。',
        undefined,
        { path },
      )
    }

    return { path: resolvedPath, root }
  }

  private async ensureRoot(
    workspaceRoot: string = this.workspaceRoot,
  ): Promise<string> {
    await mkdir(workspaceRoot, { recursive: true })
    return realpath(workspaceRoot)
  }

  private resolveInsideRoot(root: string, path: string): string {
    const relativePath = normalizeRelativePath(path)
    const resolvedPath = resolve(root, relativePath)
    if (!getRelativePathInsideRoot(root, resolvedPath)) {
      throw new AppError(
        'PERMISSION',
        '浏览器工作区文件路径不能离开当前站点目录。',
        undefined,
        {
          path,
        },
      )
    }

    return resolvedPath
  }
}

function createBrowserWorkspaceFileAccess(
  workspaceRoot: string,
  legacyWorkspaceRoots: readonly string[] = [],
): BrowserWorkspaceFileAccess {
  return new BrowserWorkspaceFileAccess(workspaceRoot, legacyWorkspaceRoots)
}

/** 直接按站点上下文建文件访问器；历史根的挂接口径只有这一处，免得每个调用点各记一遍。 */
function createBrowserSiteWorkspaceFileAccess(
  context: Pick<BrowserSiteContext, 'workspaceRoot' | 'legacyWorkspaceRoots'>,
): BrowserWorkspaceFileAccess {
  return new BrowserWorkspaceFileAccess(
    context.workspaceRoot,
    context.legacyWorkspaceRoots ?? [],
  )
}

export {
  BrowserWorkspaceFileAccess,
  createBrowserSiteWorkspaceFileAccess,
  createBrowserWorkspaceFileAccess,
}
