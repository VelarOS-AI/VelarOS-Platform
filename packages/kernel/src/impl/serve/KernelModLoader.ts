import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  isArray,
  isNotUndefined,
  isNull,
  isObject,
  isUndefined,
  Log,
  toOptional,
} from '@velaros-ai/core'

import type { KernelModuleDefinition, KernelModuleImporter } from '../../contract/requires'
import type {
  KernelModPackLoadFailure,
  KernelModPackRecord,
  LoadModsResult,
} from '../../types/serve'
import { isNodeError } from '../../utils/fs'
import {
  describeModPackLoadFailure,
  parseModPackDirectoryManifest,
  toKernelModuleDefinition,
  toModPackImportUrl,
  toModPackIndexFileContent,
  toModPackRecordFromIndexEntry,
} from '../../utils/serve/mod-index'
import { VelarosModManifestFileName } from '../../utils/wire/mod-envelope'
import type { KernelModPackKind } from '../../utils/wire/mods'

import {
  BundledSpecifierScheme,
  type KernelModStoreApi,
  type KernelModStorePaths,
} from './KernelModStore'

const log = Log.tag('KernelModLoader')

/** 把 ModStore 里开着的 pack 解析成模块定义；实例归装配守护进程的那一处。 */
export interface KernelModLoaderApi {
  /** 逐个装开着的 pack：装成的进 modules，装不上的进 failures 并写回仓库，本身永远不抛。 */
  loadEnabled(): Promise<LoadModsResult>
}

/** 按 ModStore 里开着的 pack 装出模块定义。 */
export class KernelModLoader implements KernelModLoaderApi {
  public constructor(
    private readonly store: KernelModStoreApi,
    private readonly importModule?: KernelModuleImporter,
  ) {}

  /**
   * 装载每一个开着的 pack，**按 pack 隔离故障**。
   *
   * installed pack 的入口是顶层 `await` 背后的第三方代码；让一次坏导入冒出这里，整个 Kernel
   * 进程会跟着它一起倒。现在一次失败只损失那一件能力：记日志、在仓库上登记成失败 pack、
   * 放进 {@link LoadModsResult.failures}——绝不静悄悄吞掉。
   *
   * P4 之后运行期失败面只剩 **installed pack**：bundled pack 的模块随构建图进来，坏掉的那个是
   * 构建红，不是降级启动。隔离仍然保留——它是 installed 通道的合同，不是 bundled 通道的。
   *
   * 客户端看到的现象是「mods.list 里开着、handshake 的 modules 里没有」；在 mods 的 wire 描述
   * 长出状态字段之前，人读得懂的原因只在 Kernel 日志里。
   */
  public async loadEnabled(): Promise<LoadModsResult> {
    const enabled = this.store.listEnabled()
    const modules: KernelModuleDefinition[] = []
    const packs: KernelModPackRecord[] = []
    const failures: KernelModPackLoadFailure[] = []
    for (const pack of enabled) {
      try {
        // 编进构建的 pack：模块随构建图进来，没有什么要解析或导入的，`specifier` 只是它的身份。
        let definition = pack.module
        if (isUndefined(definition)) {
          if (pack.specifier.startsWith(BundledSpecifierScheme)) {
            // 孤儿：持久化的索引里还记着一个本次构建已不再编入的 pack。它的身份 URI 不能导入，
            // 直接说明原因，不要让它落进无意义的文件路径导入。
            throw new Error(
              `mod pack "${pack.id}" 是随包编译进来的，但这次构建里已经没有它了（"${pack.specifier}"）`,
            )
          }
          // 「按运行期才知道的路径加载代码」静态依赖图表达不了，所以包内不留动态 `import()`：
          // 导入函数是注入面（`KernelModuleImporter`），由 `bin/` 下的可执行文件交进来。
          if (isUndefined(this.importModule)) {
            throw new Error(
              `mod pack "${pack.id}" 要按路径导入，但本次装配没有注入模块导入函数（bootKernelDaemon 的 importModule）`,
            )
          }
          const importUrl = toModPackImportUrl(pack.specifier)
          const exported = await this.importModule(importUrl)
          const exportName = pack.exportName ?? 'default'
          definition = toKernelModuleDefinition(exported[exportName])
          if (isUndefined(definition)) {
            throw new Error(
              `mod pack "${pack.id}" 在 "${importUrl}" 上的导出 "${exportName}" 不是一个 KernelModuleDefinition`,
            )
          }
        }
        modules.push(definition)
        packs.push(pack)
        this.store.clearLoadFailure(pack.id)
      } catch (error) {
        const failure: KernelModPackLoadFailure = {
          id: pack.id,
          kind: pack.kind,
          specifier: pack.specifier,
          reason: describeModPackLoadFailure(error),
        }
        this.store.markLoadFailure(failure)
        failures.push(failure)
        log.error('mod pack 装载失败', { failure })
      }
    }
    return { modules, packs, failures }
  }

}

/**
 * 把一个 user / contrib pack 目录装进仓库索引。
 *
 * 读 `<packDir>/velaros.mod.json` 里的 **`module` 一节**——内核只认这一节；`agent` / `ui` 归
 * Agent 主干与产品外壳，这里连看都不看。这条读取权限的切分，是挡住装载器长回上帝对象的
 * 机械防线。
 *
 * 安装时的状态（kind / enabled）由安装方决定，不由 mod 自己声明：一个 pack 不能自称 contrib，
 * 也不能自称装上就是停用的。
 */
export async function installModPackFromDirectory(
  store: KernelModStoreApi,
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
  store.register(pack)
  await persistModIndex(store)
  return pack
}

/** 把持久化的 mod 索引读回仓库；索引文件不存在时什么也不做，坏掉的条目逐条跳过。 */
export async function loadModIndexIntoStore(
  store: KernelModStoreApi,
  paths: KernelModStorePaths = store.paths,
): Promise<void> {
  if (isUndefined(paths.indexPath)) return
  try {
    const parsed = JSON.parse(await readFile(paths.indexPath, 'utf8')) as unknown
    if (!isObject(parsed) || isNull(parsed)) return
    const packs = Reflect.get(parsed, 'packs')
    if (!isArray(packs)) return
    for (const entry of packs) {
      const record = toModPackRecordFromIndexEntry(entry)
      if (isNotUndefined(record)) store.register(record)
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

/**
 * 把 pack 索引（身份加开关位）落盘；没配索引路径时什么也不做。
 *
 * bundled pack 的 `module` 是活的对象图、不是数据，落盘时刻意丢掉：索引持久化的是**决定**
 * （用户关掉了哪些 pack），载荷永远从构建图里再来一次。
 */
export async function persistModIndex(store: KernelModStoreApi): Promise<void> {
  const indexPath = store.paths.indexPath
  if (isUndefined(indexPath)) return
  await mkdir(resolve(indexPath, '..'), { recursive: true })
  await writeFile(
    indexPath,
    toModPackIndexFileContent(store.list()),
    // 索引里有本机的 pack 路径：只给属主读写。
    { encoding: 'utf8', mode: 0o600 },
  )
}
