import type { z } from 'zod'

import { isFalse } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserExtractDefaults, BrowserFileLimits } from '../../contract/constants'
import type { BrowserToolContext } from '../../contract/requires'
import type { WorkspaceWriteFileResult } from '../../types/browser'
import type {
  BrowserListArtifactsInput,
  BrowserListFilesInput,
  BrowserReadFileInput,
  BrowserSavePageSnapshotInput,
  BrowserWriteArtifactInput,
  BrowserWriteFileInput,
} from '../../types/tools.js'
import { buildBrowserArtifactAccess } from '../../utils/artifacts.js'
import type { browserFilesExactSchema } from '../../utils/schemas/files'
import { buildBrowserScreenshotOptions } from '../../utils/screenshot-options'
import { getActiveBrowserContext, requireActiveBrowserSite } from '../../utils/tool.js'
import { BrowserTuning } from '../../utils/tuning'
import { getRelativePathInsideRoot, toPortableRelativePath } from '../../utils/workspace-paths'
import {
  BrowserWorkspaceArtifactManager,
  buildBrowserPageSnapshotName,
} from '../workspace/BrowserWorkspaceArtifactManager.js'

import { BrowserExtractOperations } from './BrowserExtractOperations.js'

/**
 * `browser:files` 与 `browser:export_page` 背后的执行类：站点工作区的文件与产物。
 *
 * 每次工具调用建一份，实例带住这一次调用的工具上下文。读写都经工具上下文的浏览器文件 API，
 * 所以路径一律相对当前站点工作区，出不了这个目录；写入失败与越界由那一层按错误码抛出。
 */
export interface BrowserFileOperationsApi {
  /** 按收敛好的入参分派到六个文件/产物动作。 */
  run(input: z.output<typeof browserFilesExactSchema>): Promise<unknown>
  /** 按 kind 把当前页面导出成正文、截图、PDF、媒体清单、资源清单、表格或快照。 */
  exportPage(input: {
    kind: 'content' | 'screenshot' | 'region' | 'pdf' | 'media' | 'resources' | 'table' | 'snapshot'
    format?: 'plain' | 'markdown' | 'html'
    selector?: string
    savePath?: string
    save?: boolean
    name?: string
    fullPage?: boolean
    tableIndex?: number
    maxRows?: number
  }): Promise<unknown>
}

export class BrowserFileOperations implements BrowserFileOperationsApi {
  constructor(private readonly ctx: BrowserToolContext) {}

  public async run(input: z.output<typeof browserFilesExactSchema>): Promise<unknown> {
    switch (input.action) {
      case 'list_files':
        return this.listFiles(input)
      case 'read_file':
        return this.readFile(input)
      case 'write_file':
        return this.writeFile(input)
      case 'list_artifacts':
        return this.listArtifacts(input)
      case 'write_artifact':
        return this.writeArtifact(input)
      case 'save_page_snapshot':
        return this.savePageSnapshot(input)
      default:
        input satisfies never
        throw new AppError('VALIDATION', 'browser:files 不认识这个 action。')
    }
  }

  public async exportPage(input: {
    kind: 'content' | 'screenshot' | 'region' | 'pdf' | 'media' | 'resources' | 'table' | 'snapshot'
    format?: 'plain' | 'markdown' | 'html'
    selector?: string
    savePath?: string
    save?: boolean
    name?: string
    fullPage?: boolean
    tableIndex?: number
    maxRows?: number
  }): Promise<unknown> {
    this.begin()

    const extraction = new BrowserExtractOperations(this.ctx)
    switch (input.kind) {
      case 'content':
        return {
          kind: input.kind,
          ...(await extraction.extractPageContent({
            format: input.format ?? 'markdown',
            selector: input.selector,
            maxChars: BrowserExtractDefaults.contentChars,
            save: !isFalse(input.save),
            name: input.name,
          })),
        }
      case 'screenshot':
        return {
          kind: input.kind,
          ...(await this.ctx.browser.captureScreenshot(
            buildBrowserScreenshotOptions({
              path: input.savePath,
              fullPage: input.fullPage ?? true,
              modelFacing: true,
            })
          )),
        }
      case 'region':
        return { kind: input.kind, ...(await this.captureRegion(input)) }
      case 'pdf':
        return { kind: input.kind, ...(await this.ctx.browser.exportPagePdf({ savePath: input.savePath })) }
      case 'media':
        return {
          kind: input.kind,
          ...(await this.ctx.browser.listMediaSources({ limit: BrowserTuning.lists.exportMediaSources })),
        }
      case 'resources':
        return {
          kind: input.kind,
          ...(await this.ctx.browser.listPageResources({ limit: BrowserTuning.lists.exportMediaSources })),
        }
      case 'table':
        return {
          kind: input.kind,
          ...(await extraction.extractTable({
            selector: input.selector,
            tableIndex: input.tableIndex ?? BrowserExtractDefaults.tableIndex,
            maxRows: input.maxRows ?? BrowserExtractDefaults.tableRows,
            save: !isFalse(input.save),
            name: input.name,
          })),
        }
      case 'snapshot':
        return this.exportPageSnapshot(input.name)
      default:
        throw new AppError('VALIDATION', `不支持的导出类型：${String(input.kind)}`)
    }
  }

  /** 进入任一动作分支前的共用前置：响应中止信号、确认已经进站点。 */
  private begin(): void {
    this.ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(this.ctx)
  }

  /** 当前站点的产物管理器：只经工具上下文的文件 API 读写，出不了站点目录。 */
  private artifacts(): BrowserWorkspaceArtifactManager {
    return new BrowserWorkspaceArtifactManager(buildBrowserArtifactAccess(this.ctx))
  }

  /** 列站点工作区里的文件。 */
  private async listFiles(input: BrowserListFilesInput) {
    this.begin()

    return this.ctx.browser.listFiles({
      path: input.path,
      recursive: input.recursive,
      maxDepth: input.maxDepth,
      limit: input.limit,
    })
  }

  /** 读站点工作区里的一个文件；没给 endLine、maxChars 时按公开上限截断。 */
  private async readFile(input: BrowserReadFileInput) {
    this.begin()

    const maxChars = input.endLine || input.maxChars ? input.maxChars : BrowserFileLimits.readChars
    return this.ctx.browser.readFile(input.path, input.startLine, input.endLine, maxChars)
  }

  /** 往站点工作区写一个文件，回执里同时给绝对路径与相对路径。 */
  private async writeFile(
    input: BrowserWriteFileInput
  ): Promise<WorkspaceWriteFileResult & { relativePath: string }> {
    this.begin()

    const result = await this.ctx.browser.writeFile(input.path, input.content, {
      overwrite: !!input.overwrite,
    })
    const browserContext = getActiveBrowserContext(this.ctx)
    const relativePath = getRelativePathInsideRoot(browserContext.workspaceRoot, result.path)

    return {
      ...result,
      // 绝对路径用于当前机器上的可点击文件引用；相对路径用于展示和持久化。
      relativePath: relativePath ? toPortableRelativePath(relativePath) : input.path,
    }
  }

  /** 列站点工作区里的标准产物。 */
  private async listArtifacts(input: BrowserListArtifactsInput) {
    this.begin()

    return this.artifacts().listArtifacts({
      context: getActiveBrowserContext(this.ctx),
      kind: input.kind,
      limit: input.limit,
    })
  }

  /** 按类别与格式写一份标准产物。 */
  private async writeArtifact(input: BrowserWriteArtifactInput) {
    this.begin()

    return this.artifacts().writeArtifact({
      context: getActiveBrowserContext(this.ctx),
      kind: input.kind,
      format: input.format,
      content: input.content,
      name: input.name,
      overwrite: input.overwrite,
    })
  }

  /** 把当前页面检查结果存成 pages/ 下的页面快照。 */
  private async savePageSnapshot(input: BrowserSavePageSnapshotInput) {
    this.begin()

    const inspection = await this.ctx.browser.inspectPage({
      maxTextChars: input.maxTextChars,
      includeHtml: input.includeHtml,
      maxHtmlChars: input.maxHtmlChars,
    })
    return this.artifacts().savePageSnapshot({
      context: getActiveBrowserContext(this.ctx),
      inspection,
      name: input.name,
      overwrite: input.overwrite,
    })
  }

  /** 导出页面上的一块区域：必须给 selector，没给保存路径时按时间戳落到截图目录。 */
  private async captureRegion(input: { selector?: string; savePath?: string }) {
    if (!input.selector?.trim()) {
      throw new AppError('VALIDATION', 'kind=region 必须提供 selector。')
    }

    return this.ctx.browser.captureScreenshot(
      buildBrowserScreenshotOptions({
        path: input.savePath ?? `artifacts/screenshots/region-${Date.now()}.png`,
        region: { selector: input.selector },
        modelFacing: true,
      })
    )
  }

  /** 导出一份页面快照；没给名字时用「站点名+时间戳」，避免同页重复导出撞名硬报错。 */
  private async exportPageSnapshot(name: LooseOptional<string>) {
    const inspection = await this.ctx.browser.inspectPage({
      maxTextChars: BrowserTuning.extraction.recipeInspectTextChars,
    })
    const snapshotName =
      name?.trim() ||
      `${buildBrowserPageSnapshotName(inspection.url, inspection.title)}-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')}`
    const saved = await this.artifacts().savePageSnapshot({
      context: getActiveBrowserContext(this.ctx),
      inspection,
      name: snapshotName,
    })

    return {
      kind: 'snapshot' as const,
      inspection,
      savedPath: saved.artifact.path,
      savedRelativePath: saved.artifact.relativePath,
    }
  }
}
