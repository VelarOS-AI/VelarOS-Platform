import { isNotUndefined, Log } from '@velaros-ai/core'
import { toOptional } from '@velaros-ai/core/utils/nullish'
import type { KernelDaemonPaths } from '@velaros-ai/kernel/client/contracts'
import {
  KernelModuleApiVersion,
  type KernelModuleDefinition,
  type KernelPermissionBroker,
} from '@velaros-ai/kernel/contracts/abi'
import {
  type KernelHostBridgeRegistry,
  KernelModuleHost,
  type KernelModuleIsolationAdapter,
  parseHostBridgeEndpoint,
  SidecarIsolationAdapter,
} from '@velaros-ai/kernel/runtime'
import {
  AllowLoadedKernelClientAccessBroker,
  type KernelClientAccessBroker,
  KernelService,
} from '@velaros-ai/kernel/runtime'

import { KernelLocalDaemon } from './daemon'
import {
  installModPackFromDirectory,
  KernelModLoader,
  persistModIndex,
} from './mod-loader'
import {
  BundledSpecifierScheme,
  createDefaultKernelModStorePaths,
  type KernelModPackLoadFailure,
  type KernelModPackRecord,
  KernelModStore,
  type KernelModStorePaths,
} from './mod-store'

const log = Log.tag('KernelBoot')

export interface BootKernelDaemonOptions {
  readonly apiVersion?: number
  readonly kernelVersion: string
  /** Explicit module definitions (tests / composition roots). */
  readonly modules?: readonly KernelModuleDefinition[]
  /**
   * Pre-registered mod packs loaded when `modules` is omitted.
   *
   * This is the injection point for a host's **compile-time bundled capability
   * packs**: statically import the capability's `create*KernelModule()`, wrap it
   * with `createBundledModPack` / `toBundledPackRecords`, pass it here. The
   * Kernel side stays capability-agnostic (§15.2 依赖方向单向 ⑤→④→③→②).
   */
  readonly modPacks?: readonly KernelModPackRecord[]
  readonly modStorePaths?: KernelModStorePaths
  readonly paths?: KernelDaemonPaths
  readonly isolationAdapters?: readonly KernelModuleIsolationAdapter[]
  readonly hostBridges?: KernelHostBridgeRegistry
  /** Unix socket path for product HostBridge (overrides env when set). */
  readonly hostBridgeEndpoint?: string
  /** Host-owned capability permission policy. Secure default remains deny-all. */
  readonly permissionBroker?: KernelPermissionBroker
  /**
   * Gates capability.session.open for connected Clients.
   * Defaults to allow-any-loaded when modules are supplied; otherwise deny-all.
   */
  readonly clientAccessBroker?: KernelClientAccessBroker
}

export interface BootedKernelDaemon {
  readonly daemon: KernelLocalDaemon
  readonly service: KernelService
  readonly modStore: KernelModStore
  /** Enabled packs that failed to load; the daemon boots without them. */
  readonly modLoadFailures: readonly KernelModPackLoadFailure[]
  stop(): Promise<void>
}

/**
 * Assembles a Kernel process: ModStore/Loader, host, service, daemon.
 *
 * Module definitions come from explicit injection, enabled ModStore packs, or
 * neither (empty catalog). Kernel never statically depends on concrete caps.
 */
export async function bootKernelDaemon(
  options: BootKernelDaemonOptions,
): Promise<BootedKernelDaemon> {
  const modStore = new KernelModStore(
    options.modStorePaths ?? createDefaultKernelModStorePaths(),
  )
  if (options.modPacks) {
    modStore.registerAll(options.modPacks)
  }

  let modules: readonly KernelModuleDefinition[] = options.modules ?? []
  const modLoadFailures: KernelModPackLoadFailure[] = []
  const packByModule = new Map<KernelModuleDefinition, KernelModPackRecord>()
  if (modules.length === 0 && modStore.listEnabled().length > 0) {
    // Loader 按 pack 隔离故障：单个损坏 pack 只损失自身能力，不拖垮整个 Kernel 进程。
    const loaded = await new KernelModLoader(modStore).loadEnabled()
    modules = loaded.modules
    modLoadFailures.push(...loaded.failures)
    // `loadEnabled` 逐个 pack 同时压入 modules 与 packs，两个数组按下标一一对应。
    for (const [index, module] of loaded.modules.entries()) {
      const pack = loaded.packs[index]
      if (isNotUndefined(pack)) packByModule.set(module, pack)
    }
  }

  const hostBridgeEndpoint = parseHostBridgeEndpoint(
    options.hostBridgeEndpoint ?? process.env.VELAROS_HOST_BRIDGE_ENDPOINT,
  )
  const isolationAdapters = [
    ...(options.isolationAdapters ?? []),
    ...(options.hostBridges?.toIsolationAdapters() ?? []),
    ...(hostBridgeEndpoint
      ? [new SidecarIsolationAdapter({
          endpoint: hostBridgeEndpoint,
          allowOfflineFallback: true,
        })]
      : []),
  ]

  modules = retainActivatableModules({
    modules,
    isolationAdapters,
    packByModule,
    modStore,
    failures: modLoadFailures,
  })

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
  const service = new KernelService({
    host,
    kernelVersion: options.kernelVersion,
    clientAccessBroker: toOptional(clientAccessBroker),
    modCatalog: {
      list: () =>
        modStore.list().map((pack) => ({
          id: pack.id,
          kind: pack.kind,
          version: pack.version,
          enabled: pack.enabled,
          provides: [...pack.provides],
          specifier: pack.specifier,
        })),
      setEnabled: async (id, enabled) => {
        const ok = enabled ? modStore.enable(id) : modStore.disable(id)
        if (ok) await persistModIndex(modStore)
        return { ok, reloadRequired: true }
      },
      installFromDirectory: async (directory) => {
        const pack = await installModPackFromDirectory(modStore, directory)
        await persistModIndex(modStore)
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
    },
  })
  const daemon = new KernelLocalDaemon({
    paths: options.paths,
    service,
  })

  await service.start()
  try {
    await daemon.start()
  } catch (error) {
    try {
      await service.dispose()
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'Kernel daemon 启动失败，且回收 Kernel service 时再次失败。',
      )
    }
    throw error
  }

  return {
    daemon,
    service,
    modStore,
    modLoadFailures,
    stop: async () => {
      await daemon.dispose()
      await service.dispose()
    },
  }
}

/**
 * 丢掉本次装配**激活不了**的模块，让守护进程照常起来。
 *
 * 模块清单里的隔离形态是**数据**（bundled 目录桩、用户装的 pack、宿主注入的模块都能声明
 * 任意形态），适配器是**本次装配注入的东西**；两者对不上时，宿主让 `KernelModuleHost`
 * 在 activate 阶段抛 `MISSING_ISOLATION_ADAPTER`，整个 `velaros-kernel-daemon` 跟着退出——
 * 随包的三个 sidecar 目录桩加上「没有产品设 `VELAROS_HOST_BRIDGE_ENDPOINT`」，等于默认装配
 * 根本起不来。
 *
 * 这里按 ModLoader 的同一条口径处理：**单个模块装不上只损失它自己的能力**。跳过的模块登记成
 * 装载失败（进 `modLoadFailures`、写回 ModStore、启动日志照列），而不是静悄悄消失：客户端
 * 看到的现象仍是「mods.list 里开着、handshake 的 modules 里没有」，原因在 Kernel 日志里。
 */
function retainActivatableModules(input: {
  readonly modules: readonly KernelModuleDefinition[]
  readonly isolationAdapters: readonly KernelModuleIsolationAdapter[]
  readonly packByModule: ReadonlyMap<KernelModuleDefinition, KernelModPackRecord>
  readonly modStore: KernelModStore
  readonly failures: KernelModPackLoadFailure[]
}): readonly KernelModuleDefinition[] {
  const supported = new Set<string>(['in-process'])
  for (const adapter of input.isolationAdapters) supported.add(adapter.isolation)

  const activatable: KernelModuleDefinition[] = []
  for (const module of input.modules) {
    const { id, isolation } = module.manifest
    if (supported.has(isolation)) {
      activatable.push(module)
      continue
    }
    const pack = input.packByModule.get(module)
    const failure: KernelModPackLoadFailure = {
      id: pack?.id ?? id,
      kind: pack?.kind ?? 'system',
      specifier: pack?.specifier ?? `${BundledSpecifierScheme}${id}`,
      reason: `模块 "${id}" 声明的隔离形态 "${isolation}" 在本次装配里没有对应的适配器，已跳过；它提供的能力这次不可用。`,
    }
    if (isNotUndefined(pack)) input.modStore.markLoadFailure(failure)
    input.failures.push(failure)
    log.warn('隔离适配器缺失，跳过该模块', {
      isolation,
      moduleId: id,
      packId: failure.id,
    })
  }
  return activatable
}

/** Stops the Kernel cleanly on the usual termination signals. */
export function installKernelShutdownHandlers(
  booted: BootedKernelDaemon,
): () => void {
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void booted.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, stop)
  return () => {
    for (const signal of signals) process.off(signal, stop)
  }
}
