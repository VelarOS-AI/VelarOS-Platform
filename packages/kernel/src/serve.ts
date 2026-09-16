// 门面：`@velaros-ai/kernel/serve` —— serve 部署组合（宪章 §15.3）。
//
// 内核本体（模块宿主、能力寻址、权限、事件、状态、wire 协议）住在根入口 `@velaros-ai/kernel`；
// 本入口只把它装成本机进程：守护进程生命周期 + 本机 RPC 前脸 + ModStore + 启动器 + 更新器。
// 完整宿主的进程内装栈不经本入口，直接 `createKernel()`。
//
// 只有四件值，每一件都是一次**部署动作**：装起一个进程、当那个进程跑、起或附着到共享进程、
// 装或升级共享 Runtime。ModStore 的登记、安装与索引读写不在这里——那是 `booted.modStore`
// 上的方法（`KernelModStoreApi`），拿仓库的口子只有这一个。
export { bootKernelDaemon } from './impl/serve/KernelDaemonAssembly'
export { kernelDaemonProcess } from './impl/serve/KernelDaemonProcess'
export { createKernelLauncher } from './impl/serve/KernelLauncher'
export { createKernelUpdater } from './impl/updater/KernelUpdater'
