import { isNotUndefined, isNull, Log } from '@velaros-ai/core'
import { toOptional } from '@velaros-ai/core/utils/nullish'

import { KernelModuleApiVersion } from '../../contract/constants'
import type {
  KernelModuleDefinition,
  KernelModuleImporter,
  KernelModuleIsolationAdapter,
  KernelPermissionBroker,
} from '../../contract/requires'
import type { KernelClientAccessBroker } from '../../contract/requires'
import type { KernelDaemonPaths } from '../../types/kernel'
import type {
  KernelModCatalog,
  KernelModPackLoadFailure,
  KernelModPackRecord,
  LoadModsResult,
} from '../../types/serve'
import { installKernelShutdownSignalHandlers } from '../../utils/serve/daemon-process'
import { KernelModuleHost } from '../runtime/KernelModuleHost'

import { AllowLoadedKernelClientAccessBroker } from './AllowLoadedKernelClientAccessBroker'
import { KernelLocalDaemon, type KernelLocalDaemonApi } from './KernelLocalDaemon'
import {
  installModPackFromDirectory,
  KernelModLoader,
  persistModIndex,
} from './KernelModLoader'
import {
  BundledSpecifierScheme,
  createDefaultKernelModStorePaths,
  KernelModStore,
  type KernelModStoreApi,
  type KernelModStorePaths,
} from './KernelModStore'
import { KernelService, type KernelServiceApi } from './KernelService'

const log = Log.tag('KernelBoot')

/** 装配一个 Kernel 守护进程要交进来的东西。 */
export interface KernelDaemonAssemblyOptions {
  /** 装 installed pack 时用的模块导入函数；不给的话 installed pack 逐个登记成装载失败。 */
  readonly importModule?: KernelModuleImporter
  /** 宿主认的模块 API 版本；不给取合同里的当前版本。 */
  readonly apiVersion?: number
  /** 握手里回显的内核版本号。 */
  readonly kernelVersion: string
  /** 显式交进来的模块定义（测试与组合根用）；给了就不再去 ModStore 装。 */
  readonly modules?: readonly KernelModuleDefinition[]
  /**
   * 预先登记的 mod pack，只在没给 `modules` 时才装。
   *
   * 这是宿主注入**编译期随包能力**的口子：静态 import 能力的 `create*KernelModule()`，用
   * `createBundledModPack` / `toBundledPackRecords` 折成记录后从这里交进来。内核侧因此始终
   * 不认识任何具体能力（§15.2 依赖方向单向 ⑤→④→③→②）。
   */
  readonly modPacks?: readonly KernelModPackRecord[]
  /** ModStore 的落盘路径；不给就用缺省的 `~/.velaros`。 */
  readonly modStorePaths?: KernelModStorePaths
  /** descriptor、锁与 socket 的落点；不给就用缺省的运行目录。 */
  readonly paths?: KernelDaemonPaths
  /** 本次装配带进来的隔离适配器；模块声明的隔离形态对不上就装不起来。 */
  readonly isolationAdapters?: readonly KernelModuleIsolationAdapter[]
  /** 宿主自己的能力权限策略；安全缺省仍是 deny-all。 */
  readonly permissionBroker?: KernelPermissionBroker
  /**
   * 判外部 Client 的 `capability.session.open`。
   * 不给时：交了模块就默认「已装载即可绑」，没交模块则是 deny-all。
   */
  readonly clientAccessBroker?: KernelClientAccessBroker
}

export type { KernelDaemonAssemblyOptions as BootKernelDaemonOptions }

/** 建一个装配件要交进来的东西：装配选项、已建好的仓库，以及这次的装载结果（没装就是 `null`）。 */
export interface KernelDaemonAssemblyInput {
  /** 原样的装配选项。 */
  readonly options: KernelDaemonAssemblyOptions
  /** 已经登记好 pack 的仓库。 */
  readonly modStore: KernelModStoreApi
  /** ModLoader 这次的装载结果；显式交了 `modules` 或仓库里没有开着的 pack 时是 `null`。 */
  readonly loaded: Nullable<LoadModsResult>
}

/**
 * 装配好的一个 Kernel 进程：ModStore / Loader、宿主、服务面、守护进程；实例归起这个进程的那一处。
 *
 * 模块定义来自显式注入、ModStore 里开着的 pack，或者两者都没有（空目录）。内核永远不静态
 * 依赖任何具体能力。
 */
export interface BootedKernelDaemonApi {
  /** 本机守护进程。 */
  readonly daemon: KernelLocalDaemonApi
  /** 这个进程对外的服务面。 */
  readonly service: KernelServiceApi
  /** 这个进程的 mod pack 仓库。 */
  readonly modStore: KernelModStoreApi
  /** 开着却装不上的 pack；守护进程照常起来，只是少了这几件能力。 */
  readonly modLoadFailures: readonly KernelModPackLoadFailure[]
  /** 起服务面与守护进程；守护进程起不来时会先回收服务面再把原错误抛出去。 */
  start(): Promise<void>
  /** 停守护进程与服务面。 */
  stop(): Promise<void>
  /** 在常见终止信号上挂停机动作；返回摘掉这些监听器的函数。 */
  installShutdownHandlers(): () => void
}

export type { BootedKernelDaemonApi as BootedKernelDaemon }

/** 一个 Kernel 进程的装配件。 */
export class KernelDaemonAssembly implements BootedKernelDaemonApi {
  /** 进程内模块天然支持；别的隔离形态要本次装配带了对应适配器才算数。 */
  private static readonly AlwaysSupportedIsolation = 'in-process'

  public readonly daemon: KernelLocalDaemonApi
  public readonly service: KernelServiceApi
  public readonly modStore: KernelModStoreApi
  private readonly failures: KernelModPackLoadFailure[] = []

  public constructor(input: KernelDaemonAssemblyInput) {
    const { loaded, options } = input
    this.modStore = input.modStore

    const packByModule = new Map<KernelModuleDefinition, KernelModPackRecord>()
    let modules: readonly KernelModuleDefinition[] = options.modules ?? []
    if (!isNull(loaded)) {
      modules = loaded.modules
      this.failures.push(...loaded.failures)
      // `loadEnabled` 逐个 pack 同时压入 modules 与 packs，两个数组按下标一一对应。
      for (const [index, module] of loaded.modules.entries()) {
        const pack = loaded.packs[index]
        if (isNotUndefined(pack)) packByModule.set(module, pack)
      }
    }

    const isolationAdapters = options.isolationAdapters ?? []
    modules = this.retainActivatableModules(modules, isolationAdapters, packByModule)

    const host = new KernelModuleHost({
      apiVersion: options.apiVersion ?? KernelModuleApiVersion,
      permissionBroker: toOptional(options.permissionBroker),
      isolationAdapters,
    })
    if (modules.length > 0) {
      host.registerModules(modules)
    }
    const clientAccessBroker = options.clientAccessBroker
      ?? (
        modules.length > 0
          ? new AllowLoadedKernelClientAccessBroker(host)
          : undefined
      )
    this.service = new KernelService({
      host,
      kernelVersion: options.kernelVersion,
      clientAccessBroker: toOptional(clientAccessBroker),
      modCatalog: this.createModCatalog(),
    })
    this.daemon = new KernelLocalDaemon({
      paths: options.paths,
      service: this.service,
    })
  }

  public get modLoadFailures(): readonly KernelModPackLoadFailure[] {
    return this.failures
  }

  public async start(): Promise<void> {
    await this.service.start()
    try {
      await this.daemon.start()
    } catch (error) {
      try {
        await this.service.dispose()
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          'Kernel daemon 启动失败，且回收 Kernel service 时再次失败。',
        )
      }
      throw error
    }
  }

  public async stop(): Promise<void> {
    await this.daemon.dispose()
    await this.service.dispose()
  }

  public installShutdownHandlers(): () => void {
    return installKernelShutdownSignalHandlers(() => this.stop())
  }

  /** 把仓库接成服务面要的 mod 目录端口：列表、开关、目录安装，改动都随手落盘。 */
  private createModCatalog(): KernelModCatalog {
    const store = this.modStore
    return {
      list: () =>
        store.list().map((pack) => ({
          id: pack.id,
          kind: pack.kind,
          version: pack.version,
          enabled: pack.enabled,
          provides: [...pack.provides],
          specifier: pack.specifier,
        })),
      setEnabled: async (id, enabled) => {
        const ok = enabled ? store.enable(id) : store.disable(id)
        if (ok) await persistModIndex(store)
        return { ok, reloadRequired: true }
      },
      installFromDirectory: async (directory) => {
        const pack = await installModPackFromDirectory(store, directory)
        await persistModIndex(store)
        return {
          pack: {
            id: pack.id,
            kind: pack.kind,
            version: pack.version,
            enabled: pack.enabled,
            provides: [...pack.provides],
            specifier: pack.specifier,
          },
          reloadRequired: true,
        }
      },
    }
  }

  /**
   * 丢掉本次装配**激活不了**的模块，让守护进程照常起来。
   *
   * 模块清单里的隔离形态是**数据**（bundled 目录桩、用户装的 pack、宿主注入的模块都能声明
   * 任意形态），适配器是**本次装配注入的东西**；两者对不上时，宿主让 `KernelModuleHost`
   * 在 activate 阶段抛 `MISSING_ISOLATION_ADAPTER`，整个 `velaros-kernel-daemon` 跟着退出——
   * 一个装不上的模块不该让整个进程起不来。
   *
   * 这里按 ModLoader 的同一条口径处理：**单个模块装不上只损失它自己的能力**。跳过的模块登记成
   * 装载失败（进 `modLoadFailures`、写回 ModStore、启动日志照列），而不是静悄悄消失：客户端
   * 看到的现象仍是「mods.list 里开着、handshake 的 modules 里没有」，原因在 Kernel 日志里。
   */
  private retainActivatableModules(
    modules: readonly KernelModuleDefinition[],
    isolationAdapters: readonly KernelModuleIsolationAdapter[],
    packByModule: ReadonlyMap<KernelModuleDefinition, KernelModPackRecord>,
  ): readonly KernelModuleDefinition[] {
    const supported = new Set<string>([KernelDaemonAssembly.AlwaysSupportedIsolation])
    for (const adapter of isolationAdapters) supported.add(adapter.isolation)

    const activatable: KernelModuleDefinition[] = []
    for (const module of modules) {
      const { id, isolation } = module.manifest
      if (supported.has(isolation)) {
        activatable.push(module)
        continue
      }
      const pack = packByModule.get(module)
      const failure: KernelModPackLoadFailure = {
        id: pack?.id ?? id,
        kind: pack?.kind ?? 'system',
        specifier: pack?.specifier ?? `${BundledSpecifierScheme}${id}`,
        reason: `模块 "${id}" 声明的隔离形态 "${isolation}" 在本次装配里没有对应的适配器，已跳过；它提供的能力这次不可用。`,
      }
      if (isNotUndefined(pack)) this.modStore.markLoadFailure(failure)
      this.failures.push(failure)
      log.warn('隔离适配器缺失，跳过该模块', {
        isolation,
        moduleId: id,
        packId: failure.id,
      })
    }
    return activatable
  }
}

/**
 * 装配并启动一个 Kernel 进程（`@velaros-ai/kernel/serve` 的入口工厂）。
 *
 * 模块定义来自显式注入、ModStore 里开着的 pack，或者两者都没有（空目录）。
 */
export async function bootKernelDaemon(
  options: KernelDaemonAssemblyOptions,
): Promise<BootedKernelDaemonApi> {
  const modStore = new KernelModStore(
    options.modStorePaths ?? createDefaultKernelModStorePaths(),
  )
  if (options.modPacks) {
    modStore.registerAll(options.modPacks)
  }
  const explicitModules = options.modules ?? []
  // Loader 按 pack 隔离故障：单个损坏 pack 只损失自身能力，不拖垮整个 Kernel 进程。
  const loaded = explicitModules.length === 0 && modStore.listEnabled().length > 0
    ? await new KernelModLoader(modStore, options.importModule).loadEnabled()
    : null
  const assembly = new KernelDaemonAssembly({ loaded, modStore, options })
  await assembly.start()
  return assembly
}

/** 在常见终止信号上挂停机动作（`@velaros-ai/kernel/serve` 的入口函数，转交给装配件自己）。 */
export function installKernelShutdownHandlers(
  booted: BootedKernelDaemonApi,
): () => void {
  return booted.installShutdownHandlers()
}
