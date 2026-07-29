/**
 * Module-scoped state surface.
 *
 * The host binds the namespace; modules can never address another module's
 * state directly.
 */
export interface KernelStateStore {
  get<TValue = unknown>(key: string): Promise<TValue | undefined>
  set<TValue = unknown>(key: string, value: TValue): Promise<void>
  delete(key: string): Promise<boolean>
  list(prefix?: string): Promise<readonly string[]>
}
