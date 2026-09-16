# `@velaros-ai/kernel/serve`

把同一套 library-first Kernel 组合为可选独立进程。它不是第二个 Kernel。

| 值 | 职责 |
| --- | --- |
| `bootKernelDaemon` | 装配并启动一个 Kernel 进程：ModStore、Loader、宿主、服务面、本机 RPC |
| `kernelDaemonProcess` | 可执行文件那一侧：读环境变量、起守护进程、挂停机信号 |
| `createKernelLauncher` | 起（或附着到）共享 Kernel 进程，并交回一个验过健康的客户端 |
| `createKernelUpdater` | artifact 校验、安装、激活指针与回滚 |

`velaros-kernel-daemon` 指向 `bin/velaros-kernel-daemon.mjs`。完整宿主不需要该入口，直接
`createKernel()`（根入口 `@velaros-ai/kernel`）。

```ts
import { createProjectKernelModule } from '@velaros-ai/project'
import { bootKernelDaemon } from '@velaros-ai/kernel/serve'

const projectModule = createProjectKernelModule({ resolveContext })

const booted = await bootKernelDaemon({
  kernelVersion,
  bundledPacks: [{
    id: 'velaros.project',
    version: projectModule.manifest.version,
    provides: projectModule.manifest.provides.map((token) => token.id),
    module: projectModule,
  }],
})

// 不过网络的进程内客户端，走的是和本机 RPC 完全相同的一条调用路径。
const client = booted.createClient()
```

Updater 只处理字节、签名与版本指针，不调用能力、不启动进程，也不依赖合同、进程内内核、
client 或其它 serve 切片。该方向由 `check:kernel-arch` 锁定。
