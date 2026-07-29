# @velaros-ai/system-tools 中文接口文档

## 定位与非目标

本包提供文件系统、搜索、shell、进程、打开路径、系统概览、项目发现和运行时诊断工具。默认工具面保持精简，高层发现和诊断放在扩展集合中。

本包不拥有 Workspace 根目录注册、不依赖 Electron、产品 IPC 或 Agent runtime，也不保存跨应用的后台任务状态。

## 安装

```bash
npm install @velaros-ai/system-tools
```

完整 System 工具运行时要求 Node.js 20 及以上。只消费 `/contracts` 的浏览器、
renderer 或 Web Worker 不需要 Node.js 运行时和 Node 类型声明。

## 公共入口

```ts
import {
  systemTools,
  systemProjectTools,
  systemExtensionTools,
  createLocalSystemKernel,
  SystemPlatformCompatibility,
  createSystemToolsKernelModule,
  type SystemToolContext,
  type SystemToolSystemApi,
} from '@velaros-ai/system-tools'
```

浏览器安全的平台辅助入口：

```ts
import { SystemPlatformCompatibility } from '@velaros-ai/system-tools/platform-compatibility'
```

浏览器安全的纯类型契约入口：

```ts
import type {
  SystemBackgroundTaskRecord,
  SystemEnvironmentInspection,
  SystemOverview,
  SystemToolInstallSuggestion,
} from '@velaros-ai/system-tools/contracts'
```

`/contracts` 没有运行时工具、文件系统、进程或 shell 实现。平台判断等运行时值应
从 `/platform-compatibility` 导入；Node 宿主的工具集合与本地实现继续从根入口
导入。

## 核心类与接口

- `SystemToolSystemApi`：工具所需的系统能力端口。
- `SystemToolContext`：单次调用的系统 API、审批、执行和取消上下文。
- `SystemPlatformCompatibility`：显式平台与环境下的路径、shell 和启动规则。
- `createLocalSystemKernel()`：Node.js 本地默认实现；每个实例拥有自己的后台任务注册表。
- `systemTools`：默认正交工具面。
- `systemProjectTools` / `systemExtensionTools`：显式加载的项目发现与诊断面。
- `createSystemToolsKernelModule()`：Kernel SDK 适配器。

## 生命周期/并发

每个宿主或租户创建自己的 System API 实例。`createLocalSystemKernel()` 的后台任务只在该实例内可见，不再使用模块级全局 Map。进程启动、查询与终止需要由同一实例协调。

工具 context 按调用创建；取消通过 AbortSignal 传播。文件写入和命令执行的并发策略由宿主 API 负责。

## 依赖注入

生产应用可以完全实现 `SystemToolSystemApi`，也可以使用 `createLocalSystemKernel()`。Kernel 模块通过 `resolveContext(scope, signal)` 延迟解析租户/会话上下文，不要求全局单例。

## 错误模型

工具输入由 Zod 校验。系统领域使用 `AppError`，区分 validation、permission、not found、platform 和 execution failed。命令执行使用结构化 `SystemCommandResult`，调用方不应仅依据 stderr 文本判断结果。

## 最小第三方示例

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
  approval: myApprovalPort,
  execution: null,
}

const overview = systemTools.get_system_overview
const result = await overview.execute(overview.schema.parse({}), context)
```

## 扩展点

第三方宿主通过 `SystemToolSystemApi` 接入容器、远程机器或受限沙箱。应用专属系统能力应组合到自己的扩展集合，不应扩大默认 `systemTools`。平台差异集中在 `SystemPlatformCompatibility`。

## 兼容策略

现有工具名、三个工具集合和 Kernel capability ID 保持兼容。默认 `systemPlatformCompatibility` 继续存在但仅作为兼容便利项；确定性宿主应构造自己的实例。
