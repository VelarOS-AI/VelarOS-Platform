import type { BrowserToolContext } from '../../contract/requires'
import type {
  BrowserWorkspaceArtifactFormat,
  BrowserWorkspaceArtifactKind,
  WorkspaceWriteFileResult,
} from '../../types/browser'
import { getActiveBrowserContext, requireActiveBrowserSite } from '../../utils/tool.js'
import { getRelativePathInsideRoot, toPortableRelativePath } from '../../utils/workspace-paths'
import { BrowserWorkspaceArtifactManager } from '../workspace/BrowserWorkspaceArtifactManager.js'

/**
 * 创建当前 browser 工作区的 artifact manager。
 *
 * manager 只通过 ToolBrowserApi 读写文件，因此天然被限制在当前站点的私有目录中。
 */
export function createArtifactManager(ctx: BrowserToolContext): BrowserWorkspaceArtifactManager {
  requireActiveBrowserSite(ctx)

  // 用 browser 文件 API 适配 artifact manager，避免它直接依赖 workspace/root 路径。
  return new BrowserWorkspaceArtifactManager({
    readFile: (path, startLine, endLine, maxChars) =>
      ctx.browser.readFile(path, startLine, endLine, maxChars),
    writeFile: (path, content, options) => ctx.browser.writeFile(path, content, options),
    listFiles: (options) => ctx.browser.listFiles(options),
  })
}

const BrowserReadDefaultMaxChars = 200_000

type BrowserListFilesInput = {
  path?: string
  recursive?: boolean
  maxDepth?: number
  limit: number
}

type BrowserReadFileInput = {
  path: string
  startLine?: number
  endLine?: number
  maxChars?: number
}

type BrowserWriteFileInput = {
  path: string
  content: string
  overwrite?: boolean
}

type BrowserListArtifactsInput = {
  kind?: BrowserWorkspaceArtifactKind
  limit: number
}

type BrowserWriteArtifactInput = {
  kind: BrowserWorkspaceArtifactKind
  format: BrowserWorkspaceArtifactFormat
  content: string
  name?: string
  overwrite?: boolean
}

type BrowserSavePageSnapshotInput = {
  name?: string
  includeHtml?: boolean
  maxTextChars?: number
  maxHtmlChars?: number
  overwrite?: boolean
}

async function listBrowserWorkspaceFiles(
  { path, recursive, maxDepth, limit }: BrowserListFilesInput,
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  return ctx.browser.listFiles({
    path,
    recursive,
    maxDepth,
    limit,
  })
}

async function readBrowserWorkspaceFile(
  { path, startLine, endLine, maxChars }: BrowserReadFileInput,
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()
  const readMaxChars = endLine || maxChars ? maxChars : BrowserReadDefaultMaxChars
  requireActiveBrowserSite(ctx)

  return ctx.browser.readFile(path, startLine, endLine, readMaxChars)
}

async function writeBrowserWorkspaceFile(
  { path, content, overwrite }: BrowserWriteFileInput,
  ctx: BrowserToolContext
): Promise<WorkspaceWriteFileResult & { relativePath: string }> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  const result = await ctx.browser.writeFile(path, content, { overwrite: !!overwrite })
  const browserContext = getActiveBrowserContext(ctx)
  const relativePath = getRelativePathInsideRoot(browserContext.workspaceRoot, result.path)

  return {
    ...result,
    // absolute path 用于当前机器上的可点击文件引用；relativePath 用于展示和持久化。
    relativePath: relativePath ? toPortableRelativePath(relativePath) : path,
  }
}

async function listBrowserWorkspaceArtifacts(
  { kind, limit }: BrowserListArtifactsInput,
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()

  return createArtifactManager(ctx).listArtifacts({
    context: getActiveBrowserContext(ctx),
    kind,
    limit,
  })
}

async function writeBrowserWorkspaceArtifact(
  { kind, format, content, name, overwrite }: BrowserWriteArtifactInput,
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()

  return createArtifactManager(ctx).writeArtifact({
    context: getActiveBrowserContext(ctx),
    kind,
    format,
    content,
    name,
    overwrite,
  })
}

async function saveBrowserPageSnapshot(
  { name, includeHtml, maxTextChars, maxHtmlChars, overwrite }: BrowserSavePageSnapshotInput,
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()

  const inspection = await ctx.browser.inspectPage({
    maxTextChars,
    includeHtml,
    maxHtmlChars,
  })
  return createArtifactManager(ctx).savePageSnapshot({
    context: getActiveBrowserContext(ctx),
    inspection,
    name,
    overwrite,
  })
}

export {
  listBrowserWorkspaceArtifacts,
  listBrowserWorkspaceFiles,
  readBrowserWorkspaceFile,
  saveBrowserPageSnapshot,
  writeBrowserWorkspaceArtifact,
  writeBrowserWorkspaceFile,
}
