import { isNumber, isObject,isString, stringifyPretty, toNullable } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import {
  applyBrowserRecipeTemplate,
  type BrowserRecipeTemplate,
  buildBrowserRecipeSkeleton,
} from './BrowserRecipeSkeletonBuilder'
import type {
  BrowserPageInspection,
  BrowserRecipeSkeleton,
  BrowserSiteContext,
  BrowserWorkspaceArtifactFormat,
  BrowserWorkspaceArtifactKind,
  BrowserWorkspaceArtifactRecord,
  BrowserWorkspaceManifest,
  WorkspaceFileEntry,
  WorkspaceListOptions,
  WorkspaceReadFileResult,
  WorkspaceWriteFileOptions,
  WorkspaceWriteFileResult,
} from './types'

const BrowserWorkspaceManifestVersion = 1 as const
const BrowserWorkspaceManifestPath = 'manifest.json'
const log = logRuntime.tag('BrowserWorkspaceArtifactManager')

/** browser workspace 内不同 artifact 类型的目录。 */
const BrowserWorkspaceArtifactDirectoryMap: Record<BrowserWorkspaceArtifactKind, string> = {
  page: 'pages',
  recipe: 'recipes',
  extract: 'extracts',
  note: 'notes',
  run: 'runs',
  download: 'downloads',
}

/** artifact 格式到文件扩展名的映射。 */
const BrowserWorkspaceArtifactFormatExtensionMap: Record<BrowserWorkspaceArtifactFormat, string> = {
  json: 'json',
  text: 'txt',
  markdown: 'md',
  html: 'html',
}

/** BrowserWorkspaceArtifactManager 需要的文件系统访问接口。 */
interface BrowserWorkspaceArtifactAccess {
  readFile: (
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ) => Promise<WorkspaceReadFileResult>
  writeFile: (
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ) => Promise<WorkspaceWriteFileResult>
  listFiles: (options?: WorkspaceListOptions) => Promise<WorkspaceFileEntry[]>
}

/** 写入通用浏览器 artifact 的输入。 */
interface WriteBrowserArtifactInput {
  context: BrowserSiteContext
  kind: BrowserWorkspaceArtifactKind
  format: BrowserWorkspaceArtifactFormat
  content: string
  name?: string
  overwrite?: boolean
}

/** 保存页面快照输入。 */
interface SaveBrowserPageSnapshotInput {
  context: BrowserSiteContext
  inspection: BrowserPageInspection
  name?: string
  overwrite?: boolean
}

/** 保存 recipe skeleton 输入。 */
interface SaveBrowserRecipeSkeletonInput {
  context: BrowserSiteContext
  inspection: BrowserPageInspection
  sourceSnapshotPath?: LooseOptional<string>
  name?: string
  overwrite?: boolean
  /** C3: 预设模板名，自动在 suggestedSteps 前插入常用操作步骤骨架 */
  template?: BrowserRecipeTemplate
}

/**
 * 浏览器工作区 artifact 管理器。
 *
 * 负责维护 manifest，并把页面快照、recipe、抽取结果等写入浏览器工作区目录。
 */
class BrowserWorkspaceArtifactManager {
  constructor(private readonly access: BrowserWorkspaceArtifactAccess) {}

  /** 创建或刷新 manifest。 */
  public async ensureManifest(context: BrowserSiteContext): Promise<BrowserWorkspaceManifest> {
    const existingManifest = await this.tryLoadManifest()
    const savedAt = Date.now()
    const manifest: BrowserWorkspaceManifest = {
      version: BrowserWorkspaceManifestVersion,
      siteUrl: context.url,
      siteOrigin: getBrowserSiteOrigin(context.url),
      workspaceRoot: context.workspaceRoot,
      directories: BrowserWorkspaceArtifactDirectoryMap,
      // createdAt 只在首次创建时固定，lastActivatedAt 每次进入该站点刷新。
      createdAt: existingManifest?.createdAt ?? savedAt,
      lastActivatedAt: savedAt,
    }

    await this.access.writeFile(
      BrowserWorkspaceManifestPath,
      `${stringifyPretty(manifest)}\n`,
      {
        overwrite: true,
      }
    )

    return manifest
  }

  /** 读取 manifest；缺失或损坏时自动重建。 */
  public async getManifest(context: BrowserSiteContext): Promise<BrowserWorkspaceManifest> {
    return (await this.tryLoadManifest()) ?? this.ensureManifest(context)
  }

  /** 列出浏览器工作区 artifact。 */
  public async listArtifacts(args: {
    context: BrowserSiteContext
    kind?: BrowserWorkspaceArtifactKind
    limit: number
  }): Promise<WorkspaceFileEntry[]> {
    await this.ensureManifest(args.context)
    const directories = args.kind
      ? [BrowserWorkspaceArtifactDirectoryMap[args.kind]]
      : Object.values(BrowserWorkspaceArtifactDirectoryMap)
    const entries = await Promise.all(
      directories.map(async (path) => {
        try {
          return await this.access.listFiles({
            path,
            recursive: true,
            maxDepth: 4,
            limit: args.limit,
          })
        } catch (error) {
          log.debug('列出浏览器工作区产物目录失败', { path, error })
          return []
        }
      })
    )

    return entries.flat().slice(0, args.limit)
  }

  /** 写入任意类型 artifact。 */
  public async writeArtifact(input: WriteBrowserArtifactInput): Promise<BrowserWorkspaceArtifactRecord> {
    const manifest = await this.ensureManifest(input.context)
    const relativePath = buildBrowserArtifactRelativePath(input.kind, input.format, input.name)
    const result = await this.access.writeFile(relativePath, input.content, {
      overwrite: !!input.overwrite,
    })

    return {
      kind: input.kind,
      format: input.format,
      path: result.path,
      relativePath,
      bytes: result.bytes,
      savedAt: manifest.lastActivatedAt,
    }
  }

  /** 保存页面检查结果快照。 */
  public async savePageSnapshot(input: SaveBrowserPageSnapshotInput): Promise<{
    artifact: BrowserWorkspaceArtifactRecord
    page: {
      url: string
      title: string
      capturedAt: number
      headings: number
      links: number
      textChars: number
    }
  }> {
    const artifact = await this.writeArtifact({
      context: input.context,
      kind: 'page',
      format: 'json',
      content: `${JSON.stringify(input.inspection)}\n`,
      name:
        input.name || buildBrowserPageSnapshotName(input.inspection.url, input.inspection.title),
      overwrite: input.overwrite,
    })

    return {
      artifact,
      page: {
        url: input.inspection.url,
        title: input.inspection.title,
        capturedAt: input.inspection.capturedAt,
        headings: input.inspection.headings.length,
        links: input.inspection.links.length,
        textChars: input.inspection.text.length,
      },
    }
  }

  /** 根据页面检查结果保存 recipe skeleton。 */
  public async saveRecipeSkeleton(input: SaveBrowserRecipeSkeletonInput): Promise<{
    artifact: BrowserWorkspaceArtifactRecord
    recipe: {
      url: string
      title: string
      stepCount: number
      linkCount: number
    }
    skeleton: BrowserRecipeSkeleton
  }> {
    const baseSkeleton = buildBrowserRecipeSkeleton(
      input.inspection,
      (toNullable(input.sourceSnapshotPath))
    )
    // C3: 模板步骤插入 — 将预设模板步骤合并到推导步骤前面，避免模型重复推导常见流程
    const skeleton = input.template
      ? applyBrowserRecipeTemplate(baseSkeleton, input.template)
      : baseSkeleton
    const artifact = await this.writeArtifact({
      context: input.context,
      kind: 'recipe',
      format: 'json',
      content: `${stringifyPretty(skeleton)}\n`,
      name:
        input.name || buildBrowserRecipeSkeletonName(input.inspection.url, input.inspection.title),
      overwrite: input.overwrite,
    })

    return {
      artifact,
      recipe: {
        url: skeleton.url,
        title: skeleton.title,
        stepCount: skeleton.suggestedSteps.length,
        linkCount: skeleton.primaryLinks.length,
      },
      skeleton,
    }
  }

  /** 尝试读取已有 manifest。 */
  private async tryLoadManifest(): Promise<Nullable<BrowserWorkspaceManifest>> {
    try {
      const file = await this.access.readFile(BrowserWorkspaceManifestPath, 1, undefined, 200000)
      const parsed = JSON.parse(file.content) as Partial<BrowserWorkspaceManifest>
      if (
        parsed.version === BrowserWorkspaceManifestVersion && isString(parsed.siteUrl) && isString(parsed.workspaceRoot) && isNumber(parsed.createdAt) && isNumber(parsed.lastActivatedAt) &&
        parsed.directories && isObject(parsed.directories)
      ) return parsed as BrowserWorkspaceManifest
    } catch (error) {
      log.debug('读取浏览器工作区清单失败', { error })
      // Ignore invalid or missing manifest and let ensureManifest regenerate it.
    }

    return null
  }
}

/** 根据页面 URL/标题生成页面快照文件名。 */
function buildBrowserPageSnapshotName(url: string, fallbackTitle?: string): string {
  try {
    const parsedUrl = new URL(url)
    const normalizedPath = `${parsedUrl.pathname}${parsedUrl.search}`
      .replace(/^\/+/, '')
      .replace(/\/+/g, '-')
    const candidate = normalizedPath || fallbackTitle || 'home'
    return slugifyArtifactName(candidate, 'page')
  } catch (error) {
    log.debug('从 URL 推导浏览器页面快照名称失败', { url, error })
    return slugifyArtifactName(fallbackTitle || url, 'page')
  }
}

/** 根据页面 URL/标题生成 recipe skeleton 文件名。 */
function buildBrowserRecipeSkeletonName(url: string, fallbackTitle?: string): string {
  return `${buildBrowserPageSnapshotName(url, fallbackTitle)}-skeleton`
}

/** 根据类型、格式和名称生成 artifact 相对路径。 */
function buildBrowserArtifactRelativePath(
  kind: BrowserWorkspaceArtifactKind,
  format: BrowserWorkspaceArtifactFormat,
  name?: string
): string {
  const directory = BrowserWorkspaceArtifactDirectoryMap[kind]
  const extension = BrowserWorkspaceArtifactFormatExtensionMap[format]
  const slug = slugifyArtifactName(name, kind)
  return `${directory}/${slug}.${extension}`
}

/** 从 URL 获取站点 origin。 */
function getBrowserSiteOrigin(url: string): Nullable<string> {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.origin !== 'null' ? parsedUrl.origin : null
  } catch (error) {
    log.debug('从 URL 推导浏览器站点来源失败', { url, error })
    return null
  }
}

/** 将任意标题/路径片段转成安全文件名。 */
function slugifyArtifactName(value: string | undefined, fallbackPrefix: string): string {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) ?? ''

  if (normalized) return normalized

  const timePart = new Date().toISOString().replace(/[:.]/g, '-')
  return `${fallbackPrefix}-${timePart}`
}

/** 创建 artifact manager 的工厂函数。 */
function createBrowserWorkspaceArtifactAccess(
  args: BrowserWorkspaceArtifactAccess
): BrowserWorkspaceArtifactManager {
  return new BrowserWorkspaceArtifactManager(args)
}

export {
  BrowserWorkspaceArtifactDirectoryMap,
  BrowserWorkspaceArtifactFormatExtensionMap,
  BrowserWorkspaceArtifactManager,
  BrowserWorkspaceManifestPath,
  BrowserWorkspaceManifestVersion,
  buildBrowserArtifactRelativePath,
  buildBrowserPageSnapshotName,
  buildBrowserRecipeSkeleton,
  buildBrowserRecipeSkeletonName,
  createBrowserWorkspaceArtifactAccess,
}
export type { BrowserWorkspaceArtifactAccess }
