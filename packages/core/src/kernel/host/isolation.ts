import type {
  Awaitable,
  KernelModuleActivateContext,
  KernelModuleDefinition,
  KernelModuleIsolation,
  KernelModuleLifecycle,
} from '../abi'

export type ExternalKernelModuleIsolation = Exclude<
  KernelModuleIsolation,
  'in-process'
>

/**
 * Host-injected transport boundary for non-local modules.
 *
 * An adapter is responsible for process creation, transport, and mapping the
 * remote lifecycle onto `KernelModuleLifecycle`.
 */
export interface KernelModuleIsolationAdapter {
  readonly isolation: ExternalKernelModuleIsolation
  activate(
    module: KernelModuleDefinition,
    context: KernelModuleActivateContext,
  ): Awaitable<KernelModuleLifecycle | void>
}
