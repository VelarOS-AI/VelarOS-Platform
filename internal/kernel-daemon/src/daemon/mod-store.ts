import { homedir } from 'node:os'
import { join } from 'node:path'

import type { KernelModPackKind } from '../protocol'

export type { KernelModPackKind }

export interface KernelModPackRecord {
  readonly id: string
  readonly kind: KernelModPackKind
  readonly version: string
  /** Absolute path or file URL to the module entry that exports KernelModuleDefinition. */
  readonly specifier: string
  readonly exportName?: string
  readonly enabled: boolean
  /** Capability ids this pack claims to provide (for discovery before load). */
  readonly provides: readonly string[]
}

/**
 * A pack that is enabled but could not be turned into a module this boot.
 *
 * Kept in memory only: the `mods.*` wire descriptor has no status field yet, so
 * the reason travels through the Kernel log; in-process callers (boot result,
 * daemon assembly, tests) read it from the store.
 */
export interface KernelModPackLoadFailure {
  readonly id: string
  readonly kind: KernelModPackKind
  readonly specifier: string
  /** Human-readable cause (import throw, bad export shape, …). */
  readonly reason: string
}

export interface KernelModStorePaths {
  /** Directory of installed user packs (`~/.velaros/mods` by default). */
  readonly userModsDirectory: string
  /** Optional JSON index overriding / extending discovered packs. */
  readonly indexPath?: string
}

export function createDefaultKernelModStorePaths(
  root = join(homedir(), '.velaros'),
): KernelModStorePaths {
  return {
    userModsDirectory: join(root, 'mods'),
    indexPath: join(root, 'mod-index.json'),
  }
}

/**
 * Installed mod pack index (system / user / contrib).
 *
 * Does not load modules — that is ModLoader's job after resolving enabled packs.
 */
export class KernelModStore {
  private readonly packs = new Map<string, KernelModPackRecord>()
  private readonly loadFailures = new Map<string, KernelModPackLoadFailure>()

  public constructor(
    public readonly paths: KernelModStorePaths = createDefaultKernelModStorePaths(),
  ) {}

  public register(pack: KernelModPackRecord): void {
    if (pack.id.trim().length === 0) {
      throw new Error('Mod pack id must not be empty')
    }
    this.packs.set(pack.id, Object.freeze({ ...pack, provides: [...pack.provides] }))
    // A re-registered pack (reinstall / path update) starts from a clean slate.
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
    if (pack === undefined) return false
    if (pack.enabled) return true
    this.packs.set(id, { ...pack, enabled: true })
    return true
  }

  public disable(id: string): boolean {
    const pack = this.packs.get(id)
    if (pack === undefined) return false
    if (!pack.enabled) return true
    this.packs.set(id, { ...pack, enabled: false })
    return true
  }

  public findByCapability(capabilityId: string): readonly KernelModPackRecord[] {
    return this.list().filter((pack) => pack.provides.includes(capabilityId))
  }

  /** Records that an enabled pack failed to load; ModLoader owns the call. */
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

/**
 * Register system packs from a JSON payload without importing capability packages.
 *
 * Shape: `[{ "id", "version", "specifier", "exportName"?, "provides": string[], "enabled"? }]`
 *
 * Enabled-state precedence: explicit `enabled` in the payload → whatever the
 * store already holds (the persisted mod index, loaded before registration) →
 * enabled by default for a first-time registration. Re-registration refreshes
 * version/specifier/provides but must not resurrect a pack the user disabled.
 */
export function registerSystemModPacks(
  store: KernelModStore,
  packs: ReadonlyArray<{
    readonly id: string
    readonly version: string
    readonly specifier: string
    readonly exportName?: string
    readonly provides: readonly string[]
    readonly enabled?: boolean
  }>,
): void {
  for (const pack of packs) {
    store.register({
      id: pack.id,
      kind: 'system',
      version: pack.version,
      specifier: pack.specifier,
      ...(pack.exportName === undefined ? {} : { exportName: pack.exportName }),
      enabled: pack.enabled ?? store.get(pack.id)?.enabled ?? true,
      provides: [...pack.provides],
    })
  }
}
