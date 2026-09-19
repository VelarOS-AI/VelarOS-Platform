import { readdir } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { mkdir, realpath } from 'node:fs/promises'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { resolve } from 'node:path'

import { isObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { currentPlatform } from '@velaros-ai/core/platform'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import type { WorkspaceFileEntry } from '../types/browser.js'
import type { ProjectReadFileResult } from '../types/browser.js'
import type { BrowserWorkspaceResolvedPath } from '../types/workspace.js'
import type { BrowserWorkspacePath } from '../types/workspace.js'

import { clampInteger } from './numbers.js'

/**
 * 解析站点工作区内的相对保存路径，防目录穿越。
 *
 * 判定走 {@link resolveBrowserWorkspacePath}（按真实路径，解开符号链接）：与站点工作区的文件访问
 * 同一份实现，工作区里指向外面的符号链接读写都拒绝。
 */
export async function resolveWorkspaceFilePath(
  workspaceRoot: string,
  requestedPath: string,
  label = '路径'
): Promise<BrowserWorkspacePath> {
  return resolveBrowserWorkspacePath(workspaceRoot, requestedPath, label)
}

/**
 * 纯文本的包含判定：candidate 在 root 之内时返回相对路径（root 本身是 `.`），否则 null。
 *
 * 只算字符串（折叠 `.` 与 `..`、大小写按平台），**不解符号链接**——列目录、给已经解析过的
 * 真实路径贴相对路径这类场景够用；凡是要按结果决定「能不能读写」的地方一律走
 * {@link resolveBrowserWorkspacePath}，它先把链接解开再判。
 */
export function getRelativePathInsideRoot(
  rootPath: string,
  candidatePath: string
): Nullable<string> {
  return currentPlatform.relativePathTextInside(resolve(candidatePath), resolve(rootPath))
}

/**
 * 站点工作区路径解析的**全包唯一实现**：engine 落盘（截图、录屏、堆快照、下载、PDF）、
 * 上传与站点工作区的文件访问 都走这里。
 *
 * 判定按**真实路径**来：先把工作区根与目标路径上的符号链接全部解开（路径还不存在时解开最近
 * 一个存在的祖先、悬空链接照它指向的位置继续解），再判包含。曾经的两套判定里，engine 这一套
 * 只做字面 `path.resolve`：工作区里只要有一个指向外面的符号链接（用户或别的空间建的），
 * `fetch_resource` / `handle_download` / 截图就能写到工作区外，`upload_file` 能把链接指向的
 * 任意文件（例如私钥）传给网页——而同一个链接在站点工作区的文件访问那套判定里是拒绝的。
 *
 * 只接受相对路径：绝对路径由调用方自己决定要不要放行（宿主预览有单独的入口）。
 */
export async function resolveBrowserWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  label = '路径'
): Promise<BrowserWorkspacePath> {
  const trimmed = requestedPath.trim()
  if (!trimmed) {
    throw new AppError('VALIDATION', `${label}不能为空。`)
  }
  if (currentPlatform.isAbsolutePathText(trimmed)) {
    throw new AppError('VALIDATION', `${label}必须是当前站点工作区内的相对路径。`, undefined, {
      path: requestedPath,
    })
  }

  const realRoot = await resolveRealPath(workspaceRoot)
  const literalPath = resolve(realRoot, trimmed)
  const realPath = await resolveRealPath(literalPath)
  const relativePath = currentPlatform.relativePathTextInside(realPath, realRoot)
  if (!relativePath) {
    throw new AppError('PERMISSION', `${label}不能离开当前站点工作区。`, undefined, {
      path: requestedPath,
    })
  }

  return { path: realPath, relativePath, literalPath }
}

/** 读一个已经确认在工作区内的文件，并按行与字符上限截断。 */
export async function readResolvedFile(
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

/**
 * 列目录：主根与历史根**取并集**，同名相对路径以主根为准。
 *
 * 只列主根会让「换粒度」在界面上等价于「资产没了」——制品面板是用户确认自己东西还在的
 * 唯一入口。上限按合并后的总数算，不给历史根额外配额。
 */

export function isMissingFileError(error: unknown): boolean {
  return isObject(error) && (error as { code?: unknown }).code === 'ENOENT'
}

/** 确保工作区根目录存在，返回它的真实路径。 */
export async function ensureRoot(workspaceRoot: string): Promise<string> {
  await mkdir(workspaceRoot, { recursive: true })
  return realpath(workspaceRoot)
}

/** 在一个根下把相对路径解析成真实路径；文件不在就返回 null。 */
export async function resolveExistingPathInRoot(
  workspaceRoot: string,
  path: string,
): Promise<BrowserWorkspaceResolvedPath> {
  const root = await ensureRoot(workspaceRoot)
  const target = await resolveBrowserWorkspacePath(
    root,
    normalizeRelativePath(path),
    '浏览器工作区文件路径',
  )
  const existingStats = await lstat(target.literalPath).catch((error: any) => {
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

  return { path: target.path, root }
}

/** 工作区相对路径归一：反斜杠当分隔符，去掉首尾的分隔符与空段。 */
export function normalizeRelativePath(path: LooseOptional<string>): string {
  const value = path?.trim() || '.'
  if (isAbsolute(value)) {
    throw new AppError('PERMISSION', '浏览器工作区文件路径必须是相对路径。')
  }

  return value
}

/** 列一个根下的文件条目，按上限与深度收口；根不存在时当空目录。 */
export async function collectRootEntries(input: {
  workspaceRoot: string
  path: string
  recursive: boolean
  limit: number
  maxDepth: number
  entries: WorkspaceFileEntry[]
  seenRelativePaths: Set<string>
}): Promise<void> {
  const { entries, limit, maxDepth, recursive, seenRelativePaths } = input
  const target = await resolveExistingPathInRoot(
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
