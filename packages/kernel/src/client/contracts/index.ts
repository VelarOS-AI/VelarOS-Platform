// 门面：Client 与 Kernel 服务端共享的契约（descriptor、endpoint、RPC 帧、健康度、identity 入参）。
//
// 健康度与 identity 入参的实现住在内核基础层 `@velaros-ai/kernel/contracts`（服务端产出这些
// 形状），本包把它们并进同一张对外契约面，让瘦客户端只认一处；descriptor / endpoint / RPC 帧是
// serve 部署模式的连线契约，实现留在本包。
export * as KernelAbi from '../../contracts/abi'
export type { KernelModuleHealthStatus } from '../../contracts/abi/module'
export * as KernelProtocol from '../../contracts/protocol'
export type { KernelServiceHealth, KernelServiceModuleHealth } from '../../contracts/service/health'
export type { KernelDaemonEndpointDescriptor, KernelDaemonPaths } from './descriptor'
export {
  createDefaultKernelDaemonPaths,
  defaultKernelRuntimeDirectory,
  parseKernelDaemonDescriptor,
} from './descriptor'
export type { KernelRpcEndpoint, TcpKernelRpcEndpoint, UnixKernelRpcEndpoint } from './endpoint'
export type {
  KernelRpcError,
  KernelRpcEventFrame,
  KernelRpcFailure,
  KernelRpcMethod,
  KernelRpcRequest,
  KernelRpcResponse,
  KernelRpcServerFrame,
  KernelRpcSuccess,
} from './rpc-frames'
export { KernelRpcMethods } from './rpc-frames'
