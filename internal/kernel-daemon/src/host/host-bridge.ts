import type {
  Awaitable,
  KernelModuleActivateContext,
  KernelModuleDefinition,
  KernelModuleLifecycle,
} from '@velaros-ai/kernel-sdk'

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
 * they do not inject Mods through kernel-client.
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
 * Adapts a product-registered {@link KernelHostBridge} into the Host isolation
 * adapter surface.
 */
export class HostBridgeIsolationAdapter implements KernelModuleIsolationAdapter {
  public readonly isolation: ExternalKernelModuleIsolation

  public constructor(private readonly bridge: KernelHostBridge) {
    this.isolation = bridge.isolation
  }

  public activate(
    module: KernelModuleDefinition,
    context: KernelModuleActivateContext,
  ): Awaitable<KernelModuleLifecycle | void> {
    return this.bridge.activate(module, context)
  }
}

/**
 * Registry of HostBridges keyed by bridge id (typically capability or module id).
 */
export class KernelHostBridgeRegistry {
  private readonly bridges = new Map<string, KernelHostBridge>()

  public register(bridge: KernelHostBridge): void {
    if (bridge.id.trim().length === 0) {
      throw new Error('HostBridge id must not be empty')
    }
    this.bridges.set(bridge.id, bridge)
  }

  public get(id: string): KernelHostBridge | undefined {
    return this.bridges.get(id)
  }

  public list(): readonly KernelHostBridge[] {
    return [...this.bridges.values()]
  }

  /** Build isolation adapters for every registered bridge. */
  public toIsolationAdapters(): readonly KernelModuleIsolationAdapter[] {
    return this.list().map((bridge) => new HostBridgeIsolationAdapter(bridge))
  }
}
