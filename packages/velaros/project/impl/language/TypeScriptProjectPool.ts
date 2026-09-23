import { isAbsolute } from 'node:path'

import * as ts from 'typescript'

import { AppError, isPresent, isString } from '@velaros-ai/core'

import type {
  PooledTypeScriptProject,
  TypeScriptLanguageServiceLease,
  TypeScriptProjectCacheEntry,
} from '../../types/typescript.js'
import {
  cacheKeyBelongsToProject,
  collectTypeScriptFilesFromConfig,
  createLanguageServiceHost,
  extensionWithDot,
  parseTypeScriptProjectConfig,
  projectCacheKeyOf,
  resolveDefaultLibFilePath,
  setPooledFile,
  TypeScriptExtensions,
} from '../../utils/language/typescript-config.js'
import { DevelopmentTuning } from '../../utils/tuning.js'

/**
 * 宿主面：TypeScript 语言服务池对外只有两件事——声明标准库在哪，以及关项目时把它放掉。
 *
 * 实例是 `typeScriptProjects`。池里每个（项目根，tsconfig）常驻一个 `ts.LanguageService`，
 * 里面是最多两千个文件的全文；monorepo 里每个子包一个 tsconfig，长跑的宿主打开的项目越多占用越大，
 * 所以宿主必须拿得到释放口。池本身另有一个按最近使用淘汰的上限兜底。
 */
export interface TypeScriptProjectsApi {
  /**
   * 声明宿主携带的 TypeScript 标准库目录（内含 `lib.*.d.ts`），传 `null` 撤销声明。
   *
   * 只在 `typescript` 包自身目录找不到标准库时生效。Electron 宿主若按约定把
   * `node_modules/typescript/lib/lib*.d.ts` 作为 extraResources 放到
   * `<process.resourcesPath>/typescript/lib`，无需调用它。已池化的语言服务绑定了旧的标准库位置，
   * 所以声明一变就整池重建。目录不是绝对路径时抛 `VALIDATION`。
   */
  configureLibraryDirectory(directory: Nullable<string>): void
  /**
   * 释放语言服务：给项目根就只放这个项目的，不给就整池放掉。
   *
   * 宿主关闭项目时调；调用方本来就按 `isCurrent()` 处理服务被回收的情况，所以随时可以调。
   */
  release(projectRoot?: string): void
}

/** 包内面：语言服务本体的取用口，只有 JavaScript / TypeScript 语言服务会用，不出包。 */
export interface TypeScriptProjectPoolAccess {
  /**
   * 取（或建）请求文件所属项目的语言服务，并把这一轮的脏正文作为 overlay 塞进去。
   *
   * 上一轮的 overlay 若不在这一轮的集合里，会被还原成磁盘快照里的内容（磁盘上没有则整条删）——
   * 否则某次调用临时塞进去的正文会永久污染后续所有查询。
   */
  acquire(
    projectRoot: string,
    requestAbsolutePath: string,
    priorityPaths: readonly string[],
    overlayFiles: ReadonlyMap<string, string>
  ): TypeScriptLanguageServiceLease
}

/**
 * `velaros:code` 内置基线背后的 `ts.LanguageService` 池。
 *
 * ## 为什么要池化（而不是每次调用建一个 program）
 * `ts.createLanguageService` 本身很便宜，贵的是它第一次 `getSemanticDiagnostics` 时把整个程序
 * （项目源码 + `lib.*.d.ts` + `node_modules` 类型）解析并类型检查一遍——数百毫秒到数秒。
 * 池化让**同一项目的连续工具调用共用增量缓存**，这是这个类全部复杂度的唯一理由。
 *
 * ## 两级缓存，同一把键（`projectRoot\0configPath`）
 * | 表 | 存什么 | 何时失效 |
 * |---|---|---|
 * | `projectCache` | 解析好的 `tsconfig` 配置 + 源码快照 `diskFiles` | 配置、源码或依赖清单指纹变化 |
 * | `pooledProjects` | 活的 `ts.LanguageService` + 文件版本表 | 随 `projectCache` 失效而 `dispose` |
 *
 * 两表必须同生共死：配置变了却留着旧 service，等于用旧 `compilerOptions` 回答新问题。
 * 所以取缓存时在指纹不匹配时**先 dispose 池中 service 再重建快照**。
 *
 * ## 版本号是增量缓存的开关（改这里最容易把性能整没）
 * `getScriptVersion` 返回的号一变，TS 就丢弃该文件的解析与类型结果。所以 `setPooledFile`
 * 只在内容真的变了才加一；写成「每次 acquire 都 bump」会让池化彻底失效，表面看不出错，
 * 只是每次调用都慢回未池化的水平。
 *
 * ## 标准库（`lib.*.d.ts`）按候选目录定位，找不到时显式降级
 * `ts.getDefaultLibFilePath` 只认 `typescript` 包自身所在目录。Electron 打包会剔除 `node_modules`
 * 里的 `.d.ts`，于是那里只剩 `typescript.js`：标准库静默缺席，每个 `Record`/`Set`/`string.trim`
 * 都被报成类型错误，诊断整体失真。候选目录依次是 `typescript` 包自身目录、
 * {@link TypeScriptProjectsApi.configureLibraryDirectory} 声明的目录、Electron 约定目录。
 * 都没命中时 `acquire` 报告 `standardLibraryAvailable: false`，由调用方放弃依赖类型检查的结果，
 * 而不是把伪错误当真结论返回。
 */
class TypeScriptProjectPool implements TypeScriptProjectsApi, TypeScriptProjectPoolAccess {
  private readonly projectCache = new Map<string, TypeScriptProjectCacheEntry>()
  private readonly pooledProjects = new Map<string, PooledTypeScriptProject>()
  private configuredLibraryDirectory: Nullable<string> = null

  public configureLibraryDirectory(directory: Nullable<string>): void {
    if (isPresent(directory) && !isAbsolute(directory)) {
      throw new AppError('VALIDATION', `TypeScript 标准库目录必须是绝对路径：${directory}`)
    }
    this.configuredLibraryDirectory = directory
    this.release()
  }

  public release(projectRoot?: string): void {
    if (!projectRoot) {
      for (const project of this.pooledProjects.values()) project.service.dispose()
      this.projectCache.clear()
      this.pooledProjects.clear()
      return
    }

    for (const key of [...this.projectCache.keys()]) {
      if (cacheKeyBelongsToProject(key, projectRoot)) this.projectCache.delete(key)
    }

    for (const key of [...this.pooledProjects.keys()]) {
      if (!cacheKeyBelongsToProject(key, projectRoot)) continue
      this.pooledProjects.get(key)?.service.dispose()
      this.pooledProjects.delete(key)
    }
  }

  public acquire(
    projectRoot: string,
    requestAbsolutePath: string,
    priorityPaths: readonly string[],
    overlayFiles: ReadonlyMap<string, string>
  ): TypeScriptLanguageServiceLease {
    const cacheEntry = this.getOrCreateProjectCache(projectRoot, requestAbsolutePath, priorityPaths)
    const poolKey = cacheEntry.cacheKey
    const project =
      this.pooledProjects.get(poolKey) ?? this.createPooledProject(poolKey, projectRoot, cacheEntry)
    this.touch(poolKey)

    // 只对账脏文件（overlay）：磁盘文件保持原版本号不动，TS 的增量缓存才留得住。
    const nextOverlayPaths = new Set<string>()
    for (const [path, content] of overlayFiles) {
      if (!TypeScriptExtensions.has(extensionWithDot(path))) continue
      setPooledFile(project, path, content)
      nextOverlayPaths.add(path)
    }

    for (const path of project.overlayPaths) {
      if (nextOverlayPaths.has(path)) continue

      const diskContent = project.diskFiles.get(path)
      if (!isPresent(diskContent)) {
        project.liveFiles.delete(path)
        project.fileVersions.delete(path)
      } else {
        setPooledFile(project, path, diskContent)
      }
    }

    project.overlayPaths = nextOverlayPaths

    return {
      service: project.service,
      files: project.liveFiles,
      compilerOptions: project.compilerOptions,
      config: cacheEntry.config,
      standardLibraryAvailable: isPresent(project.defaultLibFilePath),
      isCurrent: () => this.pooledProjects.get(poolKey) === project,
    }
  }

  /** 建一个新的池项：先装配 host 所需的状态切片，再补 service——host 只读文件/版本表，与 service 无环。 */
  private createPooledProject(
    poolKey: string,
    projectRoot: string,
    cacheEntry: TypeScriptProjectCacheEntry
  ): PooledTypeScriptProject {
    const liveFiles = new Map(cacheEntry.diskFiles)
    const fileVersions = new Map<string, number>()
    for (const [path] of liveFiles) fileVersions.set(path, 1)

    const draft: Omit<PooledTypeScriptProject, 'service'> = {
      projectRoot,
      projectDirectory: cacheEntry.config.projectDirectory,
      compilerOptions: cacheEntry.config.compilerOptions,
      projectReferences: cacheEntry.config.projectReferences,
      diskFiles: cacheEntry.diskFiles,
      liveFiles,
      fileVersions,
      overlayPaths: new Set(),
      defaultLibFilePath: resolveDefaultLibFilePath(
        cacheEntry.config.compilerOptions,
        this.configuredLibraryDirectory
      ),
    }
    const project: PooledTypeScriptProject = {
      ...draft,
      service: ts.createLanguageService(createLanguageServiceHost(draft)),
    }
    this.pooledProjects.set(poolKey, project)
    return project
  }

  /** 取解析好的配置与源码快照；指纹变了就先 dispose 池中服务，再重建快照。 */
  private getOrCreateProjectCache(
    projectRoot: string,
    requestAbsolutePath: string,
    priorityPaths: readonly string[]
  ): TypeScriptProjectCacheEntry {
    const config = parseTypeScriptProjectConfig(projectRoot, requestAbsolutePath)
    const cacheKey = projectCacheKeyOf(config)
    const cached = this.projectCache.get(cacheKey)
    if (cached?.config.fingerprint === config.fingerprint) return cached

    this.pooledProjects.get(cacheKey)?.service.dispose()
    this.pooledProjects.delete(cacheKey)

    const diskFiles = collectTypeScriptFilesFromConfig(config, requestAbsolutePath, priorityPaths)
    const entry: TypeScriptProjectCacheEntry = { cacheKey, config, diskFiles }
    this.projectCache.set(cacheKey, entry)
    return entry
  }

  /** 把刚用到的项目挪到队尾，并淘汰超出上限的最久未用项目。 */
  private touch(poolKey: string): void {
    const project = this.pooledProjects.get(poolKey)
    if (project) {
      // Map 按插入序遍历：删掉再放回去就是「移到队尾」。
      this.pooledProjects.delete(poolKey)
      this.pooledProjects.set(poolKey, project)
    }

    while (this.pooledProjects.size > DevelopmentTuning.typescriptProject.maxPooledProjects) {
      const oldestKey = this.pooledProjects.keys().next().value
      if (!isString(oldestKey) || oldestKey === poolKey) return
      this.pooledProjects.get(oldestKey)?.service.dispose()
      this.pooledProjects.delete(oldestKey)
      this.projectCache.delete(oldestKey)
    }
  }
}

/** 进程内唯一的一份池；包内按 `acquire` 取语言服务，不出包。 */
export const typeScriptProjectPool: TypeScriptProjectPoolAccess & TypeScriptProjectsApi =
  new TypeScriptProjectPool()

/** 宿主面的同一份池：只给声明标准库目录与释放两件事。 */
export const typeScriptProjects: TypeScriptProjectsApi = typeScriptProjectPool
