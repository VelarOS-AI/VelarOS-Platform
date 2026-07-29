export type OfficeResourceId = 'markitdown'

export interface OfficeResourceRuntime {
  extraResourceRoots(): string[]
  isDisabled(id: OfficeResourceId): boolean
}

export interface OfficeResourceRuntimeRegistryOptions {
  extraResourceRoots?: readonly string[]
  disabledResources?: readonly OfficeResourceId[]
}

/** Host-owned registry for optional Office converter resources. */
export class OfficeResourceRuntimeRegistry implements OfficeResourceRuntime {
  private readonly extraRoots = new Set<string>()
  private disabled: ReadonlySet<OfficeResourceId>

  constructor(options: OfficeResourceRuntimeRegistryOptions = {}) {
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

  public setDisabledResources(ids: readonly OfficeResourceId[]): void {
    this.disabled = new Set(ids)
  }

  public isDisabled(id: OfficeResourceId): boolean {
    return this.disabled.has(id)
  }
}

/**
 * Compatibility singleton for existing hosts.
 *
 * @deprecated Prefer an explicitly injected `OfficeResourceRuntimeRegistry`
 * owned by the application composition root.
 */
export const officeResourceRuntime = new OfficeResourceRuntimeRegistry()
