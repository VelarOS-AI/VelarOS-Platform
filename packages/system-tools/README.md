# @velaros-ai/system-tools

**系统能力契约 + 默认的 agent 系统工具面**(capabilities 域,住 `packages/system-tools`;
2026-07-30 QI 批从 `packages/capabilities/` 提到顶层)。
模型要读一个日志、跑一条命令、看看机器上有什么进程时,用的就是这里的工具。

**工具定义在一个注入的系统 API 之上**——包本身不假设自己跑在 Electron、
容器还是远程机器上;它只描述「系统能做什么」,谁来做由宿主决定。

## 分区

| 入口 | 跑在哪 | 内容 |
| --- | --- | --- |
| `@velaros-ai/system-tools` | Node ≥ 20 | 三个工具集合、`createLocalSystemKernel()`、契约、平台策略、kernel module |
| `@velaros-ai/system-tools/cli` | Node ≥ 20 | `runSystemToolsCli`,以及 bin `velaros-system` |
| `@velaros-ai/system-tools/contracts` | browser-safe | **纯类型**契约,零运行时 |
| `@velaros-ai/system-tools/platform-compatibility` | Node 类型 | 平台策略的运行时值 |

Renderer / Web Worker / RPC schema 应该从 `/contracts` 拿类型,从
`/platform-compatibility` 拿平台策略值;**只有 Node 宿主才需要从包根加载
文件、进程和 shell 工具**。

## 三个工具集合,不是一个

默认面**刻意小而正交**——工具多了模型反而选不准:

| 集合 | 内容 | 何时用 |
| --- | --- | --- |
| `systemTools` | `read` / `write` / `edit` / `list` / `grep` / `bash` / `ps` / `open` + `get_system_overview` / `refresh_shell_environment` / `list_background_tasks` / `terminate_background_task` | 默认注册面 |
| `systemProjectTools` | `discover_projects` / `list_recent_projects` / `infer_active_project` / `get_project_context` / `associate_processes_with_projects` / `summarize_current_dev_environment` / `diagnose_dev_runtime` | 按需 page-in:让模型能**发现**本机项目,而不只是列已登记的 root |
| `systemExtensionTools` | overview + project + runtime 的全集 | 明确想要大工具面的宿主 |

两条命名上的坑:

- `bash` 这个名字是**兼容旧契约**留下的,它会按宿主选 `cmd.exe` 或 POSIX shell;
  **项目工作区里的命令走 `ws_run_command`,不走这个。**
- 旧的 `atomic_*` 别名已全部退役,用上表的原语名。

## 核心概念

- **`SystemToolSystemApi`** —— 工具所需的全部系统能力端口。生产宿主可以整份自己实现
  (接容器、远程机器、受限沙箱),也可以直接用 `createLocalSystemKernel()`。
- **`SystemToolContext`** —— 一次调用的上下文:`system` / `abortSignal` /
  `approval`(审批通道)/ `execution`(交互执行通道,可为 null)/ 可选的
  `developerContext` 与 `codingSession`。
  **`approval` 始终存在且不可省略**:无人值守宿主要提供一个默认拒绝端口;
  需要审批的敏感操作在没有交互执行通道时**仍必须拒绝**。
- **`createLocalSystemKernel()`** —— Node.js 本地默认实现。
  **每个实例拥有自己的后台任务注册表**,不再用模块级全局 Map;
  进程启动、查询与终止必须由同一个实例协调。
- **`SystemPlatformCompatibility`** —— 显式平台 + 环境下的路径、shell、
  编辑器启动与后台 shell 规则。默认单例仍在,但只是便利项,
  确定性宿主自己构造实例。
- **搜索可见性策略** —— `createSystemSearchIgnorePolicy` 与
  `SystemSearchVisibility`(含 macOS TCC 受保护目录名单),
  让 `grep` / `list` 不去撞系统权限墙。
- **`createSystemToolsKernelModule()`** —— Kernel callable capability
  (`velaros.system.tools`);context 通过 `resolveContext(scope, signal)` 延迟解析,
  **不要求全局单例**。

## 典型用法

```ts
import {
  createLocalSystemKernel,
  systemTools,
  type SystemToolContext,
} from '@velaros-ai/system-tools'

const system = createLocalSystemKernel({
  cwd: '/srv/customer-project',
  homeDir: '/srv/customer',
  platform: process.platform,
})

const context: SystemToolContext = {
  system,
  abortSignal: new AbortController().signal,
  approval: myApprovalPort,   // 无人值守就给默认拒绝端口
  execution: null,
}

const overview = systemTools.get_system_overview
const result = await overview.execute(overview.schema.parse({}), context)
```

只要类型(renderer / worker / RPC 层):

```ts
import type {
  SystemBackgroundTaskRecord,
  SystemEnvironmentInspection,
  SystemOverview,
} from '@velaros-ai/system-tools/contracts'
```

## 错误模型

工具入参由 zod 校验。系统领域用 `AppError`,区分
validation / permission / not found / platform / execution failed。
命令执行返回结构化的 `SystemCommandResult`——
**调用方不要只看 stderr 文本判断成败。**

## 边界:本包不负责什么

不依赖 `@velaros-ai/agent`、不碰产品 IPC、不碰 Electron API、不碰渲染层 UI。

**最重要的一条**:workspace 根的注册、移除、激活与切换**专属于 Workspace 能力和宿主装配**,
本包一概不做。它只在注入的系统 API 之上定义工具。

应用专属的系统能力应该组合进你自己的扩展集合,**不要扩大默认 `systemTools`**;
平台差异集中在 `SystemPlatformCompatibility` 一处。

## 相邻包

| 包 | 关系 |
| --- | --- |
| `@velaros-ai/core` | 工具契约、`AppError`、kernel abi |
| `@velaros-ai/cli` | 把 `runSystemToolsCli` 注册成 `velaros system` 命名空间 |
| `@velaros-ai/workspace` | **不是依赖**;工作区根的所有权在那边,两者靠宿主装配衔接 |
| `@velaros-ai/office-tools` | 同为「宿主注入式工具包」,宿主常把同一个 system adapter 喂给两边 |

## 门

`check:capabilities-arch`、`check:capabilities-schemas`;
构建期还会跑 `generate:schema-bundle`。
