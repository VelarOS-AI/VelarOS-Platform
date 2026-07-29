# `@velaros-ai/memory/adapter-kernel` 接口文档

## 定位与非目标

本包把 `@velaros-ai/memory` 接到 Kernel 的通用能力边界，负责回合召回、Evidence 采集和
Dream 调度。它不实现 Electron、Desktop IPC、聊天数据库、Workspace 或产品配置存储。

## 安装

```bash
npm install @velaros-ai/memory/adapter-kernel @velaros-ai/memory
```

包以 ESM 发布，要求 Node.js 20 或更高版本。

## 公共入口

唯一入口是 `@velaros-ai/memory/adapter-kernel`。所有公共类、ports 和 Kernel module 工厂
都由根入口导出。

## 核心类与接口

- `MemoryAdapterRuntime`：适配器对象图，公开 `service`、`evidenceBridge` 和 `turnRecall`。
- `MemoryService`：warmup、Dream 调度、召回和治理生命周期门面。
- `MemoryEvidenceBridge`：把宿主事件归一化成 Evidence。
- `MemoryTurnRecallCoordinator`：把召回结果提供给 turn-context source。
- `MemoryDreamScheduler`：基于宿主空闲信号安排后台整理。
- `MemoryAdapterConfigPort`：功能开关读取端口。
- `MemoryAdapterHostContextPort`：scope 映射和上下文约定。
- `HostIdleSignalPort`：空闲、电池与前台状态的宿主端口。

`mountMemoryAdapter(input)` 是 `new MemoryAdapterRuntime(input)` 的兼容工厂。

## 生命周期/并发

每个 Memory domain 创建一个适配器实例。宿主 ready 后调用 `service.warmup()`，退出前调用
`service.close()`。Dream scheduler 由实例持有，不使用进程全局计时器；同一 domain 不应挂载
多个并发 scheduler。

## 依赖注入

配置、空闲信号和 scope resolver 都必须由宿主显式传入。Electron 宿主可以读取系统空闲时间，
服务器宿主也可以注入固定或自定义信号；适配器本身不判断运行平台。

## 错误模型

领域校验错误沿用 `AppError`。默认 warmup 对后台整理失败采用日志并继续策略，诊断信息保留
在 Memory run ledger；显式治理调用的错误会直接返回给调用方。

## 最小第三方示例

```ts
import {
  MemoryAdapterRuntime,
  type MountMemoryAdapterInput,
} from '@velaros-ai/memory/adapter-kernel'

declare const input: MountMemoryAdapterInput

const adapter = new MemoryAdapterRuntime(input)

await adapter.service.warmup()
const source = adapter.turnRecall.createTurnContextSource()
void source
```

仓库中的 [`examples/minimal.ts`](../examples/minimal.ts) 会随包发布，并在发布门禁中以
NodeNext、`skipLibCheck: false` 编译。

## 扩展点

- 实现自定义 `MemoryHostScopeResolver` 适配任意租户/项目模型。
- 从消息队列、HTTP 或本地事件源调用 `MemoryEvidenceBridge`。
- 用自定义 `HostIdleSignalPort` 接入服务器负载、移动端电量或前台状态。
- 通过 `createMemoryKernelModule` 挂载到其他兼容 Kernel host。

## 兼容策略

0.3.x 保留 `mountMemoryAdapter`、`MemoryAdapterMount` 及三端口结构。新增 class 只是把原来的
散装对象返回值变为明确生命周期对象，不改变三个属性。适配器只接受归一化 host contracts；
产品 DTO 不会成为公共 API。发布声明使用包内模块化 utility types，不注入 ambient globals，
也不会与 Core/UI 的类型声明冲突。
