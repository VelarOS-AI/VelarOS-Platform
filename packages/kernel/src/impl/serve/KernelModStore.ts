import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  isArray,
  isBlank,
  isNotUndefined,
  isNull,
  isObject,
  isUndefined,
  toOptional,
} from '@velaros-ai/core'

import type { KernelModuleDefinition } from '../../contract/requires'
import type {
  KernelBundledPack,
  KernelModPackLoadFailure,
  KernelModPackRecord,
  KernelModStorePaths,
  KernelSystemModPackInput,
} from '../../types/serve'
import { isNodeError } from '../../utils/fs'
import {
  parseModPackDirectoryManifest,
  toModPackIndexFileContent,
  toModPackRecordFromIndexEntry,
  toModStorePaths,
} from '../../utils/serve/mod-index'
import { toBundledPackRecords } from '../../utils/serve/mod-packs'
import { VelarosModManifestFileName } from '../../utils/wire/mod-envelope'
import type { KernelModPackKind } from '../../utils/wire/mods'

export type { KernelModPackKind }

/**
 * 把 `specifier` 标成 bundled pack 的**身份**、而不是路径的 scheme。
 *
 * 用一个带 scheme 的形态把两条 pack 通道机械分开：这个 scheme 底下的东西都是编译期的，谁都
 * 不许拿它去 import。
 */
export const BundledSpecifierScheme: string = 'bundled:'

/**
 * 已安装 mod pack 的索引（system / user / contrib）；实例归装配守护进程的那一处。
 *
 * 索引有两副身子：内存里的这一份，和落在 {@link KernelModStoreApi.paths} 下的那一份。登记与
 * 开关只改内存，什么时候写回磁盘由调用方用 {@link KernelModStoreApi.persistIndex} 决定。
 *
 * 它不装载模块——那是 ModLoader 在解析出「开着的 pack」之后的事。
 */
export interface KernelModStoreApi {
  /** 本仓库的落盘路径。 */
  readonly paths: KernelModStorePaths
  /** 登记（或覆盖登记）一个 pack；id 是空串时抛错。重新登记会清掉它上一次的装载失败。 */
  register(pack: KernelModPackRecord): void
  /** 逐个登记一批 pack。 */
  registerAll(packs: Iterable<KernelModPackRecord>): void
  /** 按 id 取一个 pack；没有就回 undefined。 */
  get(id: string): KernelModPackRecord | undefined
  /** 列出全部 pack（含停用的）。 */
  list(): readonly KernelModPackRecord[]
  /** 只列出开着的 pack。 */
  listEnabled(): readonly KernelModPackRecord[]
  /** 开一个 pack；pack 不存在时回 false。 */
  enable(id: string): boolean
  /** 关一个 pack；pack 不存在时回 false。 */
  disable(id: string): boolean
  /** 找出自称提供某件能力的全部 pack（装载前的发现用）。 */
  findByCapability(capabilityId: string): readonly KernelModPackRecord[]
  /** 登记一批系统 pack；开关位沿用仓库里已有的值，用户关掉的不会被复活。 */
  registerSystem(packs: readonly KernelSystemModPackInput[]): void
  /** 把宿主交来的编译期 pack 登记进来，返回登记后的现值。 */
  registerBundled(packs: readonly KernelBundledPack[]): readonly KernelModPackRecord[]
  /**
   * 把一个 user / contrib pack 目录装进索引并随手落盘，返回装好的记录。
   *
   * 清单不是 JSON、不合信封 schema，或者入口文件不存在时抛错，仓库保持原样。
   */
  installFromDirectory(
    packDirectory: string,
    kind?: KernelModPackKind,
  ): Promise<KernelModPackRecord>
  /** 把落盘的索引读回内存；索引文件不存在时什么也不做，坏掉的条目逐条跳过。 */
  loadPersistedIndex(): Promise<void>
  /** 把索引（身份加开关位）写回磁盘；没配索引路径时什么也不做。 */
  persistIndex(): Promise<void>
  /** 记下一个开着却装不上的 pack；由 ModLoader 调。 */
  markLoadFailure(failure: KernelModPackLoadFailure): void
  /** 清掉某个 pack 的装载失败记录（它这次装上了）。 */
  clearLoadFailure(id: string): void
  /** 取某个 pack 这次的装载失败原因；没失败就回 undefined。 */
  getLoadFailure(id: string): KernelModPackLoadFailure | undefined
  /** 列出这次启动全部装不上的 pack。 */
  listLoadFailures(): readonly KernelModPackLoadFailure[]
}

/** 已安装 mod pack 的索引。 */
export class KernelModStore implements KernelModStoreApi {
  private readonly packs = new Map<string, KernelModPackRecord>()
  private readonly loadFailures = new Map<string, KernelModPackLoadFailure>()

  public readonly paths: KernelModStorePaths

  /** 数据根目录；不给就是缺省的 `~/.velaros`，落点由内核自己定，宿主只交一个根。 */
  public constructor(modsRoot?: string) {
    this.paths = toModStorePaths(modsRoot)
  }

  public register(pack: KernelModPackRecord): void {
    if (isBlank(pack.id.trim())) {
      throw new Error('mod pack 的 id 不能为空')
    }
    this.packs.set(pack.id, Object.freeze({ ...pack, provides: [...pack.provides] }))
    // 重新注册（重装或路径更新）的 pack 从干净状态开始。
    this.loadFailures.delete(pack.id)
  }

  public registerAll(packs: Iterable<KernelModPackRecord>): void {
    for (const pack of packs) this.register(pack)
  }

  public get(id: string): KernelModPackRecord | undefined {
    return this.packs.get(id)
  }

  public list(): readonly KernelModPackRecord[] {
    return [...this.packs.values()]
  }

  public listEnabled(): readonly KernelModPackRecord[] {
    return this.list().filter((pack) => pack.enabled)
  }

  public enable(id: string): boolean {
    const pack = this.packs.get(id)
    if (isUndefined(pack)) return false
    if (pack.enabled) return true
    this.packs.set(id, { ...pack, enabled: true })
    return true
  }

  public disable(id: string): boolean {
    const pack = this.packs.get(id)
    if (isUndefined(pack)) return false
    if (!pack.enabled) return true
    this.packs.set(id, { ...pack, enabled: false })
    return true
  }

  public findByCapability(capabilityId: string): readonly KernelModPackRecord[] {
    return this.list().filter((pack) => pack.provides.includes(capabilityId))
  }

  /**
   * 登记系统 pack：随包编译的（`module` 在手）或一份可导入入口的载荷。
   *
   * 开关位的优先级：载荷里显式的 `enabled` → 仓库里已有的值（持久化的 mod 索引，在登记之前
   * 已经载入）→ 头一次登记默认开着。重新登记会刷新版本、入口与 provides，但绝不能把用户
   * 关掉的 pack 复活。
   */
  public registerSystem(packs: readonly KernelSystemModPackInput[]): void {
    for (const pack of packs) {
      this.register({
        id: pack.id,
        kind: 'system',
        version: pack.version,
        specifier: pack.specifier,
        exportName: pack.exportName,
        module: pack.module,
        enabled: pack.enabled ?? this.packs.get(pack.id)?.enabled ?? true,
        provides: [...pack.provides],
      })
    }
  }

  /**
   * 把宿主交来的编译期 pack 登记进来。
   *
   * 刻意不传 `enabled`：随包默认是「开」，但用户经 `mods.setEnabled` 停用过的 pack（持久化在
   * mod index 里、本调用之前已载入 store）必须跨重启保持关闭。返回登记后的现值。
   */
  public registerBundled(
    packs: readonly KernelBundledPack[],
  ): readonly KernelModPackRecord[] {
    const records = toBundledPackRecords(packs)
    this.registerSystem(records.map((record) => ({
      id: record.id,
      version: record.version,
      specifier: record.specifier,
      provides: record.provides,
      module: record.module as KernelModuleDefinition,
    })))
    return records.map((record) => this.packs.get(record.id) ?? record)
  }

  /**
   * 把一个 user / contrib pack 目录装进索引。
   *
   * 读 `<packDir>/velaros.mod.json` 里的 **`module` 一节**——内核只认这一节；`agent` / `ui` 归
   * Agent 主干与产品外壳，这里连看都不看。这条读取权限的切分，是挡住仓库长回上帝对象的
   * 机械防线。
   *
   * 安装时的状态（kind / enabled）由安装方决定，不由 mod 自己声明：一个 pack 不能自称 contrib，
   * 也不能自称装上就是停用的。
   */
  public async installFromDirectory(
    packDirectory: string,
    kind: KernelModPackKind = 'user',
  ): Promise<KernelModPackRecord> {
    const absolute = isAbsolute(packDirectory)
      ? packDirectory
      : resolve(process.cwd(), packDirectory)
    const manifestPath = join(absolute, VelarosModManifestFileName)
    const moduleSection = parseModPackDirectoryManifest(
      await readFile(manifestPath, 'utf8'),
      manifestPath,
    )
    const relativeSpecifier = moduleSection.entry ?? './index.js'
    const pack: KernelModPackRecord = {
      id: moduleSection.id,
      kind,
      version: moduleSection.version,
      specifier: resolve(absolute, relativeSpecifier),
      exportName: toOptional(moduleSection.exportName),
      enabled: true,
      provides: moduleSection.provides.map((token) => token.id),
    }
    await access(pack.specifier)
    this.register(pack)
    await this.persistIndex()
    return pack
  }

  public async loadPersistedIndex(): Promise<void> {
    const indexPath = this.paths.indexPath
    if (isUndefined(indexPath)) return
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as unknown
      if (!isObject(parsed) || isNull(parsed)) return
      const packs = Reflect.get(parsed, 'packs')
      if (!isArray(packs)) return
      for (const entry of packs) {
        const record = toModPackRecordFromIndexEntry(entry)
        if (isNotUndefined(record)) this.register(record)
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  /**
   * 把 pack 索引（身份加开关位）落盘。
   *
   * bundled pack 的 `module` 是活的对象图、不是数据，落盘时刻意丢掉：索引持久化的是**决定**
   * （用户关掉了哪些 pack），载荷永远从构建图里再来一次。
   */
  public async persistIndex(): Promise<void> {
    const indexPath = this.paths.indexPath
    if (isUndefined(indexPath)) return
    await mkdir(resolve(indexPath, '..'), { recursive: true })
    await writeFile(
      indexPath,
      toModPackIndexFileContent(this.list()),
      // 索引里有本机的 pack 路径：只给属主读写。
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  public markLoadFailure(failure: KernelModPackLoadFailure): void {
    this.loadFailures.set(failure.id, Object.freeze({ ...failure }))
  }

  public clearLoadFailure(id: string): void {
    this.loadFailures.delete(id)
  }

  public getLoadFailure(id: string): KernelModPackLoadFailure | undefined {
    return this.loadFailures.get(id)
  }

  public listLoadFailures(): readonly KernelModPackLoadFailure[] {
    return [...this.loadFailures.values()]
  }
}
