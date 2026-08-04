import type { KernelModPackDescriptor } from '../../contracts/protocol'

/**
 * Runtime port for ModStore management over Kernel RPC.
 *
 * Implemented by the daemon ModStore adapter; KernelService stays free of
 * filesystem/install details.
 */
export interface KernelModCatalog {
  list(): readonly KernelModPackDescriptor[]
  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ readonly ok: boolean; readonly reloadRequired: boolean }>
  installFromDirectory(
    directory: string,
  ): Promise<{
    readonly pack: KernelModPackDescriptor
    readonly reloadRequired: boolean
  }>
}
