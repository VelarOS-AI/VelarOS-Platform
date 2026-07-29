export type BrowserResourceId = 'cloakbrowser'

export interface BrowserResourceRuntime {
  extraResourceRoots(): string[]
  isDisabled(id: BrowserResourceId): boolean
}

export interface BrowserResourceRuntimeRegistryOptions {
  extraResourceRoots?: readonly string[]
  disabledResources?: readonly BrowserResourceId[]
}

/**
 * Host-owned registry for optional Browser runtime resources.
 *
 * Create one registry per application composition root. Registration is
 * idempotent and snapshots never expose mutable internal collections.
 */
export class BrowserResourceRuntimeRegistry implements BrowserResourceRuntime {
  private readonly extraRoots = new Set<string>()
  private disabled: ReadonlySet<BrowserResourceId>

  constructor(options: BrowserResourceRuntimeRegistryOptions = {}) {
    this.disabled = new Set(options.disabledResources)
    this.registerExtraResourceRoots(options.extraResourceRoots ?? [])
  }

  public registerExtraResourceRoots(roots: readonly string[]): void {
    for (const root of roots) {
      const normalized = root.trim()
      if (normalized) this.extraRoots.add(normalized)
    }
  }

  public extraResourceRoots(): string[] {
    return [...this.extraRoots]
  }

  public setDisabledResources(ids: readonly BrowserResourceId[]): void {
    this.disabled = new Set(ids)
  }

  public isDisabled(id: BrowserResourceId): boolean {
    return this.disabled.has(id)
  }
}

/**
 * Compatibility singleton for existing hosts.
 *
 * @deprecated Prefer an explicitly injected `BrowserResourceRuntimeRegistry`
 * owned by the application composition root.
 */
export const browserResourceRuntime = new BrowserResourceRuntimeRegistry()
