export type ComputerResourceId = 'computeruse'

export interface ComputerResourceRuntime {
  extraResourceRoots(): string[]
  isDisabled(id: ComputerResourceId): boolean
}

export interface ComputerResourceRuntimeRegistryOptions {
  extraResourceRoots?: readonly string[]
  disabledResources?: readonly ComputerResourceId[]
}

/** Host-owned registry for optional Computer helper resources. */
export class ComputerResourceRuntimeRegistry implements ComputerResourceRuntime {
  private readonly extraRoots = new Set<string>()
  private disabled: ReadonlySet<ComputerResourceId>

  constructor(options: ComputerResourceRuntimeRegistryOptions = {}) {
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

  public setDisabledResources(ids: readonly ComputerResourceId[]): void {
    this.disabled = new Set(ids)
  }

  public isDisabled(id: ComputerResourceId): boolean {
    return this.disabled.has(id)
  }
}

/**
 * Compatibility singleton for existing hosts.
 *
 * @deprecated Prefer an explicitly injected `ComputerResourceRuntimeRegistry`
 * owned by the application composition root.
 */
export const computerResourceRuntime = new ComputerResourceRuntimeRegistry()
