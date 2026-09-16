// 门面：@velaros-ai/kernel/serve —— serve 部署模式的配件（宪章 §15.3）。
//
// 内核本体（module host / capability registry / 权限 broker / 事件流 / 状态 / wire 协议）住在
// `@velaros-ai/kernel`；本分区只负责把它装成本机进程：daemon 生命周期 + 本机 RPC 前脸 +
// ModStore + 进程内传输。完整宿主进程内装栈**不经本包**，直接 new 内核。
//
// 产品接入远端 Kernel 用 @velaros-ai/kernel/client；Mod 开发用 @velaros-ai/kernel/contracts/abi。
export type { KernelModPackKind } from '../contracts/protocol/mods'
export type { BootedKernelDaemon, BootKernelDaemonOptions } from './daemon/boot'
export { bootKernelDaemon, installKernelShutdownHandlers } from './daemon/boot'
export type { KernelBundledPack } from './daemon/bundled-packs'
export {
  BundledKernelPacks,
  bundledPackSpecifier,
  createBundledModPack,
  registerBundledPacks,
  toBundledPackRecords,
} from './daemon/bundled-packs'
export type { KernelDaemonErrorCode, KernelLocalDaemonOptions } from './daemon/daemon'
export { KernelDaemonError, KernelLocalDaemon } from './daemon/daemon'
export type { LoadModsResult } from './daemon/mod-loader'
export {
  installModPackFromDirectory,
  KernelModLoader,
  loadModIndexIntoStore,
  persistModIndex,
} from './daemon/mod-loader'
export type {
  KernelModPackLoadFailure,
  KernelModPackRecord,
  KernelModStorePaths,
} from './daemon/mod-store'
export {
  BundledSpecifierScheme,
  createDefaultKernelModStorePaths,
  KernelModStore,
  registerSystemModPacks,
} from './daemon/mod-store'
export type { InProcessKernelService } from './internal/in-process-transport'
export { InProcessKernelTransport } from './internal/in-process-transport'
export type { KernelLocalRpcServerOptions } from './rpc/local-rpc-server'
export { createDefaultKernelRpcEndpoint, KernelLocalRpcServer } from './rpc/local-rpc-server'
export {
  decodeKernelRpcRequest,
  KernelRpcProtocolError,
  requireNonEmptyString,
  requireRecord,
  rpcFailure,
} from './rpc/server-frames'
