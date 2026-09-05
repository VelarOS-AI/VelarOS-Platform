/**
 * 稳定的产品宿主集成面。
 *
 * 此入口包含注入端口、能力扩展契约和 Kernel 适配器。产品 UI、持久化、凭据与策略仍由
 * 实现这些契约的宿主持有。
 */
export type {
  AgentModelInputModality,
  AgentModelProvider,
  AgentModelRequestOptions,
  AgentModelRequestPolicy,
  AgentModelResolverPort,
  ResolvedAgentModelRuntime,
} from '../agent/model/ModelContracts'
export type {
  AgentSurfaceProfile,
  AgentSurfaceProfileProvider,
  DerivedAgentSurfaceRunPolicy,
  DeriveSurfaceRunPolicyInput,
  ResolveAgentSurfaceInput,
} from '../agent/runner/AgentSurfaceProfile'
export type * from '../agent/runner/host-ports'
export type { AgentRuntimeEventBus } from '../agent/RuntimeEvents'
export { AgentRuntimeEvents } from '../agent/RuntimeEvents'
export type {
  AgentRuntimeInputInterruptScope,
  AgentRuntimeInputPort,
  AgentRuntimeInputResult,
} from '../agent/RuntimeInputPort'
export { createAgentRuntimeInputInterruptScope } from '../agent/RuntimeInputPort'
export type * from '../capabilities'
export type {
  AgentCapabilityExecutionContext,
  AgentCapabilityRuntime,
  AgentCapabilityService,
  CreateAgentKernelModuleOptions,
} from '../kernel-module'
export {
  AgentCapability,
  AgentExecutionPermission,
  AgentKernelModuleId,
  createAgentKernelModule,
} from '../kernel-module'
