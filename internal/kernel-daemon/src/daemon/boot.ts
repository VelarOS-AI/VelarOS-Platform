import type { KernelDaemonPaths } from '@velaros-ai/kernel-client/contracts'
import type { KernelModuleDefinition } from '@velaros-ai/kernel-sdk'

import {
  createSidecarIsolationAdapter,
  type KernelHostBridgeRegistry,
  KernelModuleHost,
  type KernelModuleIsolationAdapter,
  parseHostBridgeEndpoint,
} from '../host'
import {
  AllowLoadedKernelClientAccessBroker,
  type KernelClientAccessBroker,
  KernelService,
} from '../runtime'

import { KernelLocalDaemon } from './daemon'
import {
  installModPackFromDirectory,
  KernelModLoader,
  persistModIndex,
} from './mod-loader'
import {
  createDefaultKernelModStorePaths,
  type KernelModPackLoadFailure,
  type KernelModPackRecord,
  KernelModStore,
  type KernelModStorePaths,
} from './mod-store'

export interface BootKernelDaemonOptions {
  readonly apiVersion?: number
  readonly kernelVersion: string
  /** Explicit module definitions (tests / composition roots). */
  readonly modules?: readonly KernelModuleDefinition[]
  /** Pre-registered mod packs loaded when `modules` is omitted. */
  readonly modPacks?: readonly KernelModPackRecord[]
  readonly modStorePaths?: KernelModStorePaths
  readonly paths?: KernelDaemonPaths
  readonly isolationAdapters?: readonly KernelModuleIsolationAdapter[]
  readonly hostBridges?: KernelHostBridgeRegistry
  /** Unix socket path for product HostBridge (overrides env when set). */
  readonly hostBridgeEndpoint?: string
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
  if (options.modPacks !== undefined) {
    modStore.registerAll(options.modPacks)
  }

  let modules: readonly KernelModuleDefinition[] = options.modules ?? []
  let modLoadFailures: readonly KernelModPackLoadFailure[] = []
  if (modules.length === 0 && modStore.listEnabled().length > 0) {
    // Per-pack isolation lives in the loader: a broken pack costs its own
    // capability, not the whole Kernel process.
    const loaded = await new KernelModLoader(modStore).loadEnabled()
    modules = loaded.modules
    modLoadFailures = loaded.failures
  }

  const hostBridgeEndpoint = parseHostBridgeEndpoint(
    options.hostBridgeEndpoint ?? process.env.VELAROS_HOST_BRIDGE_ENDPOINT,
  ) ?? { kind: 'unix' as const, path: '/tmp/velaros-host-bridge-unconfigured.sock' }
  const isolationAdapters = [
    ...(options.isolationAdapters ?? []),
    ...(options.hostBridges?.toIsolationAdapters() ?? []),
    createSidecarIsolationAdapter({
      endpoint: hostBridgeEndpoint,
      allowOfflineFallback: true,
    }),
  ]

  const host = new KernelModuleHost({
    apiVersion: options.apiVersion ?? 1,
    ...(isolationAdapters.length > 0 ? { isolationAdapters } : {}),
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
    ...(clientAccessBroker === undefined
      ? {}
      : { clientAccessBroker }),
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
    await service.dispose().catch(() => undefined)
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
