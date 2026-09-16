/** 稳定 Kernel 契约；ABI 与 wire protocol 保持两套独立坐标。 */
export * as KernelAbi from './abi'
export type { KernelModuleHealthStatus } from './abi/module'
export * as KernelProtocol from './protocol'
export type { KernelServiceHealth, KernelServiceModuleHealth } from './service/health'
