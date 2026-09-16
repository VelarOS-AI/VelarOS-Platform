// 门面：`@velaros-ai/kernel/client` —— 附着到已经在跑的守护进程的瘦客户端。
//
// 只有一件值：`kernelDaemons`。算落点、读 descriptor、连上去、核协议与内核版本，交出客户端；
// 起停守护进程是 `./serve` 的事，进程内内核是根入口的事。这条入口不加载内核运行时，也不加载
// 守护进程代码（宪章 §15.3、INV-12）。
export { kernelDaemons } from './impl/client/KernelDaemonDirectory'
