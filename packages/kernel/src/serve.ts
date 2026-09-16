// 门面：@velaros-ai/kernel/serve —— serve 部署模式的配件（宪章 §15.3）。
//
// 内核本体（module host / capability registry / 权限 broker / 事件流 / 状态 / wire 协议）住在
// `@velaros-ai/kernel`；本分区只负责把它装成本机进程：daemon 生命周期 + 本机 RPC 前脸 +
// ModStore + 进程内传输。完整宿主进程内装栈**不经本包**，直接 new 内核。
//
// 产品接入远端 Kernel 用 @velaros-ai/kernel/client；Mod 开发用 @velaros-ai/kernel/contracts/abi。
export type { InProcessKernelService } from './contract/provides'
export type { BootedKernelDaemon,BootKernelDaemonOptions } from './contract/provides'
export type { KernelModuleImporter } from './contract/requires'
export { InProcessKernelTransport } from './impl/serve/InProcessKernelTransport'
export { bootKernelDaemon, installKernelShutdownHandlers } from './impl/serve/KernelDaemonAssembly'
export type {
  KernelDaemonProcessApi,
  KernelDaemonProcessEnvironment,
} from './impl/serve/KernelDaemonProcess'
export { kernelDaemonProcess } from './impl/serve/KernelDaemonProcess'
export type { KernelLocalDaemonOptions } from './impl/serve/KernelLocalDaemon'
export { KernelLocalDaemon } from './impl/serve/KernelLocalDaemon'
export type { KernelLocalRpcServerOptions } from './impl/serve/KernelLocalRpcServer'
export { createDefaultKernelRpcEndpoint, KernelLocalRpcServer } from './impl/serve/KernelLocalRpcServer'
export {
  installModPackFromDirectory,
  KernelModLoader,
  loadModIndexIntoStore,
  persistModIndex,
} from './impl/serve/KernelModLoader'
export type { KernelModStorePaths } from './impl/serve/KernelModStore'
export {
  BundledSpecifierScheme,
  createDefaultKernelModStorePaths,
  KernelModStore,
  registerSystemModPacks,
} from './impl/serve/KernelModStore'
export { registerBundledPacks } from './impl/serve/KernelModStore'
export type { LoadModsResult } from './types/serve'
export type { KernelModPackLoadFailure, KernelModPackRecord } from './types/serve'
export type { KernelBundledPack } from './types/serve'
export type { KernelSystemModPackInput } from './types/serve'
export {
  decodeKernelRpcRequest,
  requireNonEmptyString,
  requireRecord,
  rpcFailure,
} from './utils/rpc/frames'
export { bundledPackSpecifier, createBundledModPack, toBundledPackRecords } from './utils/serve/mod-packs'
export type { KernelModPackKind } from './utils/wire/mods'
