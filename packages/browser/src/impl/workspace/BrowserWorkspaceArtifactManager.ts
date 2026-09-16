import { isNumber, isObject,isString, stringifyPretty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import { BrowserWorkspaceArtifactDirectoryMap, BrowserWorkspaceArtifactFormatExtensionMap } from '../../contract/constants'
import type {
  BrowserRecipeSkeleton,
  BrowserSiteContext,
  BrowserWorkspaceArtifactFormat,
  BrowserWorkspaceArtifactKind,
  BrowserWorkspaceArtifactRecord,
  BrowserWorkspaceManifest,
  WorkspaceFileEntry,
} from '../../types/browser'
import type { BrowserWorkspaceArtifactAccess, SaveBrowserPageSnapshotInput, SaveBrowserRecipeSkeletonInput, WriteBrowserArtifactInput } from '../../types/workspace.js'
import { isManifestCurrent } from '../../utils/artifacts'
import { slugifyArtifactName } from '../../utils/artifacts'
import { getBrowserSiteOrigin } from '../../utils/artifacts.js'
import {
  applyBrowserRecipeTemplate,
  buildBrowserRecipeSkeleton,
} from '../../utils/recipes/skeleton'
import { BrowserTuning } from '../../utils/tuning'
const log = Log.tag('BrowserWorkspaceArtifactManager')

/**
 * 浏览器工作区 artifact 管理器。
 *
 * 负责维护 manifest，并把页面快照、recipe、抽取结果等写入浏览器工作区目录。
 */
export interface BrowserWorkspaceArtifactManagerApi {
  /**
   * 确保 manifest 存在且是当前站点的；**已经对得上就原样返回，不写盘**。
   *
   * 这个方法在每次 listArtifacts / writeArtifact / space_manifest 前都会被调用。老写法每次
   * 整份重写（只为刷新 lastActivatedAt），于是声明 `effectKind: 'read'`、可并发的
   * `browser:space_manifest` 每调一次就改一次盘，两个并发的 list_artifacts 还会同时整份写
   * 同一个文件。真正的「进入站点」刷新走 {@link activateManifest}。
   */
  ensureManifest(context: BrowserSiteContext): Promise<BrowserWorkspaceManifest>
  /** 读取 manifest；缺失、损坏或不是当前站点的才重建。 */
  getManifest(context: BrowserSiteContext): Promise<BrowserWorkspaceManifest>
  /** 进入站点：整份写一次 manifest，刷新 lastActivatedAt。只有 browser:enter_site 该调它。 */
  activateManifest(context: BrowserSiteContext): Promise<BrowserWorkspaceManifest>
  /** 列出浏览器工作区 artifact。 */
  listArtifacts(args: {
    context: BrowserSiteContext
    kind?: BrowserWorkspaceArtifactKind
    limit: number
  }): Promise<WorkspaceFileEntry[]>
  /** 写入任意类型 artifact。 */
  writeArtifact(input: WriteBrowserArtifactInput): Promise<BrowserWorkspaceArtifactRecord>
  /** 保存页面检查结果快照。 */
  savePageSnapshot(input: SaveBrowserPageSnapshotInput): Promise<{
    artifact: BrowserWorkspaceArtifactRecord
    page: {
      url: string
      title: string
      capturedAt: number
      headings: number
      links: number
      textChars: number
    }
  }>
  /** 根据页面检查结果保存 recipe skeleton。 */
  saveRecipeSkeleton(input: SaveBrowserRecipeSkeletonInput): Promise<{
    artifact: BrowserWorkspaceArtifactRecord
    recipe: {
      url: string
      title: string
      stepCount: number
      linkCount: number
    }
    skeleton: BrowserRecipeSkeleton
  }>
}

class BrowserWorkspaceArtifactManager implements BrowserWorkspaceArtifactManagerApi {
  private static readonly BrowserWorkspaceManifestVersion = 1 as const
  private static readonly BrowserWorkspaceManifestPath = 'manifest.json'

  constructor(private readonly access: BrowserWorkspaceArtifactAccess) {}

  /**
   * 确保 manifest 存在且是当前站点的；**已经对得上就原样返回，不写盘**。
   *
   * 这个方法在每次 listArtifacts / writeArtifact / space_manifest 前都会被调用。老写法每次
   * 整份重写（只为刷新 lastActivatedAt），于是声明 `effectKind: 'read'`、可并发的
   * `browser:space_manifest` 每调一次就改一次盘，两个并发的 list_artifacts 还会同时整份写
   * 同一个文件。真正的「进入站点」刷新走 {@link activateManifest}。
   */
  public async ensureManifest(context: BrowserSiteContext): Promise<BrowserWorkspaceManifest> {
    const existingManifest = await this.tryLoadManifest()
    if (existingManifest && isManifestCurrent(existingManifest, context)) return existingManifest

    return this.writeManifest(context, existingManifest)
  }

  /** 读取 manifest；缺失、损坏或不是当前站点的才重建。 */
  public async getManifest(context: BrowserSiteContext): Promise<BrowserWorkspaceManifest> {
    return this.ensureManifest(context)
  }

  /** 进入站点：整份写一次 manifest，刷新 lastActivatedAt。只有 browser:enter_site 该调它。 */
  public async activateManifest(context: BrowserSiteContext): Promise<BrowserWorkspaceManifest> {
    return this.writeManifest(context, await this.tryLoadManifest())
  }

  

  private async writeManifest(
    context: BrowserSiteContext,
    existingManifest: Nullable<BrowserWorkspaceManifest>
  ): Promise<BrowserWorkspaceManifest> {
    const savedAt = Date.now()
    const manifest: BrowserWorkspaceManifest = {
      version: BrowserWorkspaceArtifactManager.BrowserWorkspaceManifestVersion,
      siteUrl: context.url,
      siteOrigin: getBrowserSiteOrigin(context.url),
      workspaceRoot: context.workspaceRoot,
      directories: BrowserWorkspaceArtifactDirectoryMap,
      // createdAt 只在首次创建时固定，lastActivatedAt 每次进入该站点刷新。
      createdAt: existingManifest?.createdAt ?? savedAt,
      lastActivatedAt: savedAt,
    }

    await this.access.writeFile(
      BrowserWorkspaceArtifactManager.BrowserWorkspaceManifestPath,
      `${stringifyPretty(manifest)}\n`,
      {
        overwrite: true,
      }
    )

    return manifest
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
            maxDepth: BrowserTuning.lists.artifactDepth,
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
    await this.ensureManifest(input.context)
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
      // 落盘时刻，不是 manifest 的 lastActivatedAt：manifest 不再每次重写，那个时间戳是
      // 「上次进入站点」，拿它当产物的保存时间会把几小时前的时刻写进记录。
      savedAt: Date.now(),
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
      const file = await this.access.readFile(BrowserWorkspaceArtifactManager.BrowserWorkspaceManifestPath, 1, undefined, 200000)
      const parsed = JSON.parse(file.content) as Partial<BrowserWorkspaceManifest>
      if (
        parsed.version === BrowserWorkspaceArtifactManager.BrowserWorkspaceManifestVersion && isString(parsed.siteUrl) && isString(parsed.workspaceRoot) && isNumber(parsed.createdAt) && isNumber(parsed.lastActivatedAt) &&
        parsed.directories && isObject(parsed.directories)
      ) return parsed as BrowserWorkspaceManifest
    } catch (error) {
      if (AppError.from(error).code !== 'NOT_FOUND') {
        log.debug('浏览器工作区清单损坏，准备重新生成', { error })
      }
      // 清单缺失或无效时忽略，交给 ensureManifest 重新生成。
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

/** 创建 artifact manager 的工厂函数。 */
function createBrowserWorkspaceArtifactAccess(
  args: BrowserWorkspaceArtifactAccess
): BrowserWorkspaceArtifactManager {
  return new BrowserWorkspaceArtifactManager(args)
}

export {
  BrowserWorkspaceArtifactManager,
  buildBrowserArtifactRelativePath,
  buildBrowserPageSnapshotName,
  buildBrowserRecipeSkeleton,
  buildBrowserRecipeSkeletonName,
  createBrowserWorkspaceArtifactAccess,
}
export type { BrowserWorkspaceArtifactAccess } from '../../types/workspace.js'
