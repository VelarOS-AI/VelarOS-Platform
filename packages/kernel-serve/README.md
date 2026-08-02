# @velaros-ai/kernel-serve

**`velaros serve` 部署模式的两件配件**(kernel 域,住 `packages/kernel-serve`)。

先记住内核的形态,否则本包会被误读:**内核是库不是进程**。module ABI、wire 协议、
module host、capability registry、权限 broker、事件流、namespaced state、KernelService
——全部住在 `@velaros-ai/core/kernel`,和宿主同进程同生命周期。
本包**只提供「把那套库跑成一个独立进程」所需的装配件**,以及「把共享 Runtime 装到用户机器上」
所需的字节搬运。这里没有第二个内核。

一个安装单元、两个导入切片,**刻意不给根导出**——两切片受众不同,
装 updater 的宿主不该被迫拽进 daemon 的 RPC / ModStore 实现。

| 子路径 | 目录 | 职责 |
| --- | --- | --- |
| `@velaros-ai/kernel-serve/daemon` | `src/daemon` | daemon 生命周期 / 本机 RPC 前脸 / ModStore / 进程内传输 |
| `@velaros-ai/kernel-serve/updater` | `src/updater` | 共享 Runtime 的安装、激活指针切换与回滚 |

包还带一个 bin:`velaros-kernel-daemon` → `dist/daemon/main.js`,由 launcher spawn。

## 什么时候**不**需要本包

完整宿主(Desktop 这类)在自己进程里装内核,**直接 new `@velaros-ai/core/kernel` 即可,
不经过本包也不经过 kernel-client**——宪章 §15.1 原则一「库优先,进程可选」。
只有当你真的要一个独立的、被多个产品共享的 Kernel 进程时,才用本包。

## `daemon` 切片

- `daemon/` —— daemon 生命周期、启停握手、endpoint 描述符落盘、ModStore 与 mod 装载、
  编译期 bundled pack 清单(`daemon/bundled-packs.ts`)。
- `rpc/` —— 本机 RPC 前脸:换行分隔 JSON、Unix domain socket(Windows 走 loopback-only TCP)、
  帧编解码与鉴权。
- `internal/` —— 进程内传输:与 RPC 同语义、免序列化的 `KernelClientTransport` 实现,
  用于「同进程但仍走客户端 API」的场景。
- `main.ts` —— 进程入口。

### 两种 pack:bundled 是编译期,installed 才是运行时

宪章 §15.2 层间铁律「`bundled` = 编译期依赖」+「`importSibling` 退役」。P4 起:

| | bundled | installed |
| --- | --- | --- |
| 来源 | 构建图(静态 import) | 用户目录 / 注册表(`mods.installFromDirectory`) |
| 记录 | `module` 在手,`specifier` = `bundled:<moduleId>` 身份 URI | `specifier` = 可 import 的路径 |
| 装载 | 取字段,零 IO | 动态 import,逐 pack 失败隔离 |
| 坏了会怎样 | **构建期红** | 该 pack 缺席 + 可读失败原因,Kernel 照常起 |

**本包自己只编进 sidecar 目录桩**(agent / model / browser:目录在 Kernel,实现在宿主那侧)。
具体能力(Project / Computer / System …)的 bundled pack 归**宿主**的构建图——
依赖方向单向 ⑤→④→③→②,内核不认识能力包。宿主这样注入:

```ts
import { createProjectKernelModule } from '@velaros-ai/project'
import {
  bootKernelDaemon,
  createBundledModPack,
  toBundledPackRecords,
} from '@velaros-ai/kernel-serve/daemon'

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

## `updater` 切片

它只干一件事:**在用户机器上安装、激活、回滚共享 Kernel Runtime 的字节**。

- 枚举已装版本,报告 active 指针指向谁;
- 从 URL 或本地文件解析并校验更新清单;
- 按平台 + CPU 架构挑 artifact;
- 下载走可注入 transport,**入盘前先验 size 与 SHA-256**;
- 摘要通过后再调可插拔签名验证器;
- 并排安装进 `versions/<version>/`,用原子 rename 落地;
- 原子切换 `current.json`,并在其中留住回滚目标;
- 并发 updater 由 pid-aware 独占文件锁串行化;
- 调用方给的健康检查若否决新版本,指针回退;
- 清理旧安装时**永不**删除 active 或 rollback 版本。

```ts
import { KernelUpdater } from '@velaros-ai/kernel-serve/updater'

const updater = new KernelUpdater({
  manifestSource: 'https://updates.example.com/kernel.json',
})

const outcome = await updater.ensureCompatible({
  range: '^1.2.0',
  healthCheck: async ({ version }) => probeKernel(version),
})
console.info(outcome.version, outcome.pointer.previousVersion)
```

磁盘布局:

```
kernel/
├── versions/
│   ├── 1.0.0/
│   │   └── .kernel-install.json
│   └── 1.1.0/
├── current.json
├── runtime/
├── data/
├── backups/
├── .staging/
└── update.lock
```

`versions/<version>/.kernel-install.json` 在 rename 之前写在 staging 目录里,
所以「它存在」本身就是安装完成的证据。`.staging/` 里的任何残留都属于崩掉的那一轮,
下一次持锁的更新会直接丢弃。

**默认实现刻意是最保守的那一档**:默认解包器把 artifact 当作一个不透明载荷文件,
默认签名验证器把每个 artifact 都报成 unverified。要发 `tar.gz` / `tar.zst` / `zip`
就注入 `KernelArtifactExtractor`;有信任根就注入 `KernelArtifactSignatureVerifier`
并打开 `requireSignature`。

## 边界

依赖方向由 `check:kernel-arch` 机械看守:**updater 切片只管字节与版本指针**,
不得依赖 kernel-client、不得依赖内核本体 core,也不得相对 import 触达 daemon 切片;
daemon 切片可以用 core 与 kernel-client。合包不改变这条方向,
只是把它从「包与包之间」下沉成「切片与切片之间」。

updater 从不调用能力、从不启停 Kernel 进程、不认识产品 UI。
daemon 不做能力判定——module host、能力注册、权限判定、事件与状态全在 core。

## 相邻包

| 包 | 关系 |
| --- | --- |
| `@velaros-ai/core/kernel` | Kernel 库本体,daemon 切片的唯一内核依赖 |
| `@velaros-ai/core/kernel/abi` | Mod 开发面(写 mod 的人看这里,不看本包) |
| `@velaros-ai/kernel-client` | 瘦客户端接入面;与 daemon 共享 serve 模式的连线契约 |
| `@velaros-ai/serve-host` | 独立 Velar Host 产品组合根;注入能力、权限策略、CLI 与 Extension Bridge |

## 生产消费者

`@velaros-ai/serve-host` 已经是这条注入线的首个独立进程消费者。它复用本包的 daemon
与进程内传输,但能力组合、数据根、权限策略和产品协议仍由 Host 自己拥有;Desktop / Workbench
继续按「库优先」在自己的进程内装栈,没有被迫迁移到 serve 模式。

---

> 合包前两个独立包各自的 README 留在 [docs/daemon-README.md](./docs/daemon-README.md) 与
> [docs/updater-README.md](./docs/updater-README.md)。它们的内容已全部并入本页,
> 只作合包过程的历史留档,**冲突时以本页为准**。
