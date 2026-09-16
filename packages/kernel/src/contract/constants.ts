/**
 * Version advertised by a complete VelarOS Kernel host to mod manifests.
 *
 * This is the `engines.velaros` axis. It is deliberately independent from the
 * npm package version and from the wire protocol version.
 */
export const KernelVersion = '0.3.0'

/** Module manifest ABI accepted by the current Kernel module host. */
export const KernelModuleApiVersion = 1
