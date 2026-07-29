# @velaros-ai/kernel-serve

serve 部署模式的两件配件,一个安装单元、两个导入切片;**刻意不给根导出**——两切片受众不同,
装 updater 的宿主不该被迫拽进 daemon 的 RPC/ModStore 实现。

| 子路径 | 切片 | 职责 |
| --- | --- | --- |
| `@velaros-ai/kernel-serve/daemon` | `src/daemon` | daemon 生命周期 / 本机 RPC 前脸 / ModStore / 进程内传输 |
| `@velaros-ai/kernel-serve/updater` | `src/updater` | 共享 Runtime 的安装、激活指针切换与回滚 |

两切片的原始 README 保留在 [docs/daemon-README.md](./docs/daemon-README.md) 与
[docs/updater-README.md](./docs/updater-README.md)。

## 边界

依赖方向由 `check:kernel-arch` 机械看守:updater 切片只管字节与版本指针,**不得**依赖
kernel-client、内核本体 core,也不得相对 import 触达 daemon 切片;daemon 切片可以用 core 与
kernel-client。合包不改变这条方向,只是把它从「包与包之间」下沉成「切片与切片之间」。
