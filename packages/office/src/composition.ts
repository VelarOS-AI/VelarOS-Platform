/** 内核挂载入口（`@velaros-ai/office/composition`）：把 office 能力登记进 VelarOS 内核。 */
export type { OfficeCapabilityService } from './contract/provides.js'
export type { CreateOfficeKernelModuleOptions, OfficeToolContextResolver } from './contract/requires.js'
export { createOfficeKernelModule, OfficeCapability } from './impl/OfficeTools.js'
