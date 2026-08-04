# `@velaros-ai/kernel/serve`

把同一套 library-first Kernel 组合为可选独立进程。它不是第二个 Kernel。

| 子路径 | 职责 |
| --- | --- |
| `@velaros-ai/kernel/serve` | daemon 生命周期、本机 RPC、ModStore 与进程内 transport |
| `@velaros-ai/kernel/serve/updater` | artifact 校验、安装、激活指针与回滚 |

`velaros-kernel-daemon` 指向 `dist/serve/main.js`。完整宿主不需要该入口，直接组合
`@velaros-ai/kernel/runtime`。

```ts
import { createProjectKernelModule } from '@velaros-ai/project'
import {
  bootKernelDaemon,
  createBundledModPack,
  toBundledPackRecords,
} from '@velaros-ai/kernel/serve'

await bootKernelDaemon({
  kernelVersion,
  modPacks: toBundledPackRecords([
    createBundledModPack({
      id: 'velaros.project',
      module: createProjectKernelModule({ resolveContext }),
    }),
  ]),
})
```

Updater 只处理字节、签名与版本指针，不调用能力、不启动进程，也不依赖 contracts、runtime、
client 或其它 serve 切片。该方向由 `check:kernel-arch` 锁定。
