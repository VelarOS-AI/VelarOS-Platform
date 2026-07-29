# @velaros-ai/workspace 中文接口文档

## 定位与非目标

本包是独立的事务式本地工作区能力：观察、读取、搜索、符号解析、目标定位、补丁准备、应用、校验、回滚、批处理、审计以及插件扩展。

本包不拥有模型调用、Agent 循环、记忆、UI、Electron 或产品 IPC。`velaros` 子入口只是可选宿主 adapter，核心 `Workspace` 可被任何 Node.js 应用直接使用。

## 安装

```bash
npm install @velaros-ai/workspace
```

完整 Workspace 运行时要求 Node.js 20 及以上。只消费
`@velaros-ai/workspace/contracts` 的浏览器、renderer 或 Web Worker 不需要 Node.js
运行时，也不需要安装 Node 类型声明。

## 公共入口

主要入口：

```ts
import {
  Workspace,
  createWorkspace,
  createRecommendedWorkspace,
  WorkspaceError,
  type WorkspaceKernel,
  type WorkspaceProviders,
  type WorkspaceSymbol,
} from '@velaros-ai/workspace'
```

按需子入口包括 `/plugins`、`/providers`、`/agent-tools`、`/agent`、`/mcp`、`/presets`、`/testing`、`/cli` 和 `/result`。

浏览器安全契约入口：

```ts
import {
  WorkspaceRootSource,
  isProjectWorkspaceRootSource,
  WorkspaceKernelToolNames,
  type WorkspaceRootEntry,
  type WorkspaceReadFileResult,
} from '@velaros-ai/workspace/contracts'
```

`/contracts` 只发布 DTO、工具名和确定性的根来源规则，不包含文件系统、命令、
provider 或进程实现。Node 宿主需要完整事务能力时继续使用包根入口。

## 核心类与接口

- `Workspace`：事务和注册表的主要生命周期对象，实现 `WorkspaceKernel`。
- `WorkspaceKernel`：读取、搜索、编辑、校验、回滚和批处理的稳定 facade。
- `WorkspaceProviders`：策略、审批、命令、过滤、脱敏、代码智能、遥测和沙箱端口。
- `WorkspacePlugin`：向显式 registry 注册 adapter、patch strategy、validator、fixer、hook 和 pipeline。
- `WorkspaceSymbol`：统一符号形状；`range` 是规范位置，1.x 顶层行列字段继续兼容。
- `WorkspaceError` / `WorkspaceResult`：结构化错误和 result 风格适配。
- `createWorkspaceKernelModule()`：可选 Kernel SDK 适配器。

## 生命周期/并发

一个 `Workspace` 永久绑定一个绝对根目录。每个根目录创建独立实例，不使用进程级项目状态。文件写入通过锁和 revision 检查保护；批处理并发受 policy 限制；终态事务、目标、evidence 和审计日志都有保留上限。

插件应在开始处理请求前安装。应用结束时释放由 provider、sandbox 或 bridge 拥有的资源。

## 依赖注入

所有宿主行为都通过 `WorkspaceProviders` 注入。最小接入只需要 root；默认 Node command provider 可用。高安全场景应显式提供：

- `policy` 与 `approval`；
- `fileFilter` 与 `secretRedaction`；
- `command` 与 `sandbox`；
- 可选 `codeIntelligence` 和 `telemetry`。

## 错误模型

失败使用 `WorkspaceError`，包含稳定 code、message、details 和 suggested next action。常见代码包括 `INVALID_INPUT`、`PERMISSION_DENIED`、`BASE_REVISION_MISMATCH`、`TARGET_NOT_FOUND`、`AMBIGUOUS_TARGET`、`PROTECTED_FILE` 和 `SCOPE_VIOLATION`。

`asWorkspaceResult()` 可在 RPC 或函数式边界把异常转换成 `WorkspaceResult`，核心类内部不重复进行 DTO 转换。

## 最小第三方示例

```ts
import {
  createRecommendedWorkspace,
  WorkspaceError,
} from '@velaros-ai/workspace'

const workspace = await createRecommendedWorkspace({
  root: '/srv/customer-project',
  providers: {
    approval: {
      approve: (request) => myPolicyUi.confirm(request),
    },
  },
})

const snapshot = await workspace.read({ path: 'src/index.ts' })
const target = await workspace.resolveTarget({
  path: 'src/index.ts',
  target: { symbol: { name: 'main', kind: 'function' } },
  expectedMatches: 1,
})

if (target.status !== 'resolved') {
  throw new WorkspaceError('TARGET_NOT_FOUND', target.reason)
}
```

## 扩展点

- `FileAdapterFactory`：新文件格式；
- `PatchStrategy`：新编辑原语；
- `WorkspaceValidator` / `WorkspaceFixer`：质量门；
- `WorkspaceHook` / `PipelineStage`：生命周期观察与边界转换；
- `WorkspaceProviders`：宿主策略、远程执行、代码智能和沙箱。

扩展必须通过 registry 安装，不应访问 `Workspace` 私有 Map。

## 兼容策略

Workspace 保持 1.x 公共入口、工具名和事务语义兼容。旧的 VelarOS bridge 继续保留为子入口；第三方优先使用核心构造器和 provider。符号结果新增规范 `range`，并保留原顶层 line/column 字段。破坏事务状态机、错误代码或工具 schema 的变更需要新的主版本。
