/** 稳定 Kernel 契约；ABI 与 wire protocol 保持两套独立坐标。 */
export type { KernelModuleHealthStatus } from '../types/kernel.js'
export type { KernelServiceHealth, KernelServiceModuleHealth } from '../types/kernel.js'
export * as KernelAbi from './contracts-abi'
export * as KernelProtocol from './contracts-protocol'
