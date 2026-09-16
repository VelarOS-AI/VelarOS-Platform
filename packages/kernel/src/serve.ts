// 门面：`@velaros-ai/kernel/serve` —— serve 部署组合（宪章 §15.3）。
//
// 内核本体（模块宿主、能力寻址、权限、事件、状态、wire 协议）住在根入口 `@velaros-ai/kernel`；
// 本入口只把它装成本机进程：守护进程生命周期 + 本机 RPC 前脸 + ModStore + 启动器 + 更新器。
// 完整宿主的进程内装栈不经本入口，直接 `createKernel()`。
export { bootKernelDaemon } from './impl/serve/KernelDaemonAssembly'
export { kernelDaemonProcess } from './impl/serve/KernelDaemonProcess'
export { createKernelLauncher } from './impl/serve/KernelLauncher'
export {
  installModPackFromDirectory,
  loadModIndexIntoStore,
  persistModIndex,
} from './impl/serve/KernelModLoader'
export {
  createDefaultKernelModStorePaths,
  registerBundledPacks,
  registerSystemModPacks,
} from './impl/serve/KernelModStore'
export { createKernelUpdater } from './impl/updater/KernelUpdater'
