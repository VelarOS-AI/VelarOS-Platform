import { isBlank } from '@velaros-ai/core'

import type {
  Awaitable,
  KernelModuleActivateContext,
  KernelModuleDefinition,
  KernelModuleLifecycle,
} from '../../contracts/abi'

import { KernelHostError } from './errors'
import type {
  ExternalKernelModuleIsolation,
  KernelModuleIsolationAdapter,
} from './isolation'


/**
 * Bridge endpoint hosted by a product process that owns non-transferable
 * resources (e.g. Electron `webContents`).
 *
 * The Kernel process never receives those objects. Instead, a sidecar/bridge
 * Mod talks to this host over a local channel. Products register bridges;
 * they do not inject Mods through the client subpath.
 */
export interface KernelHostBridge {
  readonly id: string
  readonly isolation: ExternalKernelModuleIsolation
  /**
   * Activate a remote module by establishing the product-owned transport and
   * returning a lifecycle handle the Kernel Host can dispose.
   */
  activate(
    module: KernelModuleDefinition,
    context: KernelModuleActivateContext,
  ): Awaitable<KernelModuleLifecycle | void>
}

/**
 * Registry of HostBridges keyed by bridge id (typically capability or module id).
 */
export class KernelHostBridgeRegistry {
  private readonly bridges = new Map<string, KernelHostBridge>()

  public register(bridge: KernelHostBridge): void {
    if (isBlank(bridge.id.trim())) {
      throw new KernelHostError(
        'INVALID_MANIFEST',
        'HostBridge id must not be empty',
      )
    }
    this.bridges.set(bridge.id, bridge)
  }

  public get(id: string): KernelHostBridge | undefined {
    return this.bridges.get(id)
  }

  public list(): readonly KernelHostBridge[] {
    return [...this.bridges.values()]
  }

  /**
   * Expose registered bridges as isolation adapters.
   *
   * `KernelHostBridge` already carries the adapter surface (`isolation` + `activate`),
   * so no wrapper object is built: an adapter class that only forwarded both members
   * added a hop without adding meaning.
   */
  public toIsolationAdapters(): readonly KernelModuleIsolationAdapter[] {
    return this.list()
  }
}
