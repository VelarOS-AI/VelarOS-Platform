# @velaros-ai/workspace

> **位置**:VelarOS-Platform 单版本火车 · `capabilities` 域 · 目录 `packages/workspace`。
> 它是**事务式本地工作区能力**:让产品与 agent 安全地观察和修改一个本地项目,
> **而不让模型直接覆盖文件**。域归属由仓根 `package.json` 的 `velaros.domainPackages` 声明。

## 这个包解决什么问题

给模型一把 `write_file` 是最快的做法,也是最危险的做法:它会覆盖并发修改、
写坏没读过的部分、失败后留下半截文件、而且事后无从回滚。

本包的答案是**把编辑变成事务**:先解析目标(路径 / 符号 / 范围)→ 拿到 target id →
准备补丁并生成 diff → 校验 → 应用 → 需要时回滚。全过程有快照、有 revision、有审计日志。
模型看到的是「我要把 `AuthService.refreshToken` 换成这段」,而不是「我要把这个文件整个重写」。

这就是本包的中心判决:**不要把裸 `write_file` / `replace_lines` 暴露给模型**。

## 对外分区

| 子路径 | 一句话职责 |
| --- | --- |
| `@velaros-ai/workspace` | 事务内核:快照、目标解析、编辑生命周期、校验、回滚、批处理、注册表 |
| `./contracts` | **浏览器安全**的 DTO、工具名与根来源规则(不含 fs / 命令 / provider) |
| `./presets` | `createRecommendedWorkspace` —— 带推荐插件的开箱装配 |
| `./providers` | 宿主策略端口的默认实现与辅助 |
| `./plugins` | 插件总入口 |
| `./plugins/{typescript,jsts}` | JS/TS AST 符号发现与符号级补丁 |
| `./plugins/validation` | Prettier / ESLint / `tsc` / 自定义校验器 |
| `./plugins/{tree-sitter,lsp}` | 注入式 provider 插件(本包**不自带**原生解析器与语言服务器) |
| `./agent-tools` | **通用协议工具面**(`createAgentTools`):16 个 `ws_*`,第三方与 MCP 走这里 |
| `./agent` | **VelarOS 口味的工具族**(自带 `WorkspaceToolContext`),见下节 |
| `./mcp` | MCP 风格的工具适配器 |
| `./velaros` | 可选的 VelarOS 宿主 bridge |
| `./cli` | `velaros-workspace` 命令行 |
| `./testing` | 测试辅助 |
| `./result` | `WorkspaceResult` 与 `asWorkspaceResult()` 异常→结果适配 |

**本仓刻意只发布这一个包**:事务引擎、providers、CLI、插件与可选的 agent 集成全是它的子路径导出,
**没有第二个 `workspace-agent-tools` 包**。

## 两套工具面的区别(容易混)

| | `./agent-tools` | `./agent` |
| --- | --- | --- |
| 面向 | 第三方 / MCP / 通用宿主 | VelarOS 自己的 agent 运行时 |
| 上下文 | 直接吃 `WorkspaceKernel` | 自带 `WorkspaceToolContext`(注入根、授权、系统 API) |
| 编辑入口 | 完整事务协议:`ws_prepare_edit` → `ws_apply_edit`(+ `ws_amend_edit` / `ws_commit_edit`) | **`ws_edit` 一步聚合单入口** |
| 额外族 | 无 | 代码分析、编辑日志、命令执行、Git、项目速览、重构 |

**`./agent` 面已经删掉了「准备事务 → 提交事务」的两步仪式**(`ws_prepare_edit` /
`ws_amend_edit` / `ws_apply_edit` 不再对模型可见)。理由:它们的真实价值——准备事务、
原子多文件改——已被常驻的 `ws_edit` 完整覆盖,模型不该被迫手动走多轮协议。
底层 kernel 方法与门控机器仍在,供 `ws_edit` 内部复用。
**要一次原子改多个文件,就把多个 operation 放进同一次 `ws_edit` 的 `operations` 数组**,
它们在同一事务里顺序应用、一起成功或一起失败。

## 核心概念

**一个 `Workspace` 永久绑定一个绝对根目录。** 每个根建独立实例,不存在进程级项目状态。

**目标解析(target resolution)**。编辑之前先把「路径 + 符号 / 查询 / 范围」解析成一个
target id,并声明期望匹配数。解析不到或有歧义,拿到的是 `TARGET_NOT_FOUND` / `AMBIGUOUS_TARGET`,
而不是一次猜测性的错误编辑。

**base revision 与并发**。写入经每文件队列串行,应用时比对准备补丁的 base revision 与当前文件
revision。能安全重放就重放(结果里给 `rebasedFiles`),否则返回 `BASE_REVISION_MISMATCH`,
要求调用方重读并重新准备事务。

> 只有在**已知或很可能有同文件并发**时才刻意去挑「重放友好」的操作(唯一 `oldText`、
> 唯一 `anchorText`、符号操作、import 操作、自然的 append / prepend)。
> 单 agent 常规编辑就用最能表达意图的那个操作,不必自我设限。

**推荐的观察顺序**:`ws_list_files` / `ws_search` 定位 → `ws_file_stat` 拿轻量元数据 →
`ws_read`(带 `range` / `maxBytes` / 分页)有界读取 → `ws_resolve_target` → `ws_build_evidence`
打包上下文、revision 与引用。

**批处理**。`runBatch` 支持依赖 DAG、有界并发、资源元数据、读写 / 写写冲突检测,
以及可选的原子回滚。

**紧凑 schema bundle**。`createWorkspaceToolSchemaBundle()` 把公共操作结构提到 `$defs` 发一次,
而不是在每个工具 schema 里重复——面向模型的工具发现载荷因此小得多。CLI 的
`tools list` 返回同一形状。

## 典型用法

```ts
import { createRecommendedWorkspace, WorkspaceError } from '@velaros-ai/workspace'

const workspace = await createRecommendedWorkspace({
  root: '/srv/customer-project',
  providers: {
    approval: { approve: (request) => myPolicyUi.confirm(request) },
  },
})

const target = await workspace.resolveTarget({
  path: 'src/auth.ts',
  target: { symbol: { kind: 'method', container: 'AuthService', name: 'refreshToken' } },
  expectedMatches: 1,
})
if (target.status !== 'resolved') throw new WorkspaceError('TARGET_NOT_FOUND', target.reason)

const tx = await workspace.prepareEdit({
  operations: [{
    targetId: target.target.targetId,
    operation: { type: 'replace_symbol', replacement: '/* … */' },
  }],
})
console.log(tx.diff)                                    // 先看 diff
await workspace.applyEdit({ transactionId: tx.transactionId })
await workspace.validate({ transactionId: tx.transactionId, checks: ['typescript.syntax'] })
```

没有解析过的 `targetId` 时,把路径放进 `operation.path`:

```json
{ "operations": [{ "operation": {
  "type": "replace_text", "path": "src/auth.ts",
  "oldText": "return false", "newText": "return true"
} }] }
```

插件按需装:

```ts
import { createWorkspace, typescriptPlugin, validationPlugin } from '@velaros-ai/workspace'

const workspace = await createWorkspace({
  root: process.cwd(),
  plugins: [typescriptPlugin(), validationPlugin({ prettier: true, eslint: true, tsc: true })],
})
```

## 边界:本包不负责什么

**核心拥有**:文件快照与 revision、读 / 搜索派发、目标解析协议、evidence-pack 协议、
补丁事务生命周期、应用与回滚、锁与冲突检测、批处理、插件注册表、审计日志、错误分类法。

**核心不拥有**(这些是 provider 或 plugin):

- 模型调用、长期记忆、全局上下文编排、产品 UI;
- 项目特定的权限策略;
- **原生 Tree-sitter 解析器**、**语言服务器生命周期**(本包只定义注入口);
- 沙箱 / worktree 实现;
- 领域特定的文档适配器。

另外:不拥有产品 IPC、Electron UI、agent 循环编排、记忆 / 知识存储、模型适配器、产品状态。
`./velaros` 只是**可选**的宿主 adapter——核心 `Workspace` 可被任意 Node.js 应用直接使用。

renderer、Web Worker、RPC schema 与纯前端测试从 `./contracts` 取共享契约;
该入口不引入文件系统、命令执行、provider 实现或其他 Node 宿主能力。

## 与相邻包的关系

- 上游只有 `@velaros-ai/core` 与少量通用库(`diff` / `execa` / `picomatch` / `iconv-lite` / `zod` / `typescript`)。
- 与 `@velaros-ai/agent` 是**被注入关系**:本包不 import 它。
  `./agent` 子入口把 Workspace 的端口适配到宿主的通用 agent 扩展点,
  **不把 Workspace 的所有权搬进内核**。
- `src/kernel-module.ts` 提供可选的 Kernel 模块适配器(`createWorkspaceKernelModule`)。
- 姐妹能力包:`@velaros-ai/browser`、`@velaros-ai/computer`。

## 错误模型

失败用 `WorkspaceError`,带稳定 `code`、`message`、`details` 与建议的下一步动作。
常见码:`INVALID_INPUT`、`PERMISSION_DENIED`、`BASE_REVISION_MISMATCH`、`TARGET_NOT_FOUND`、
`AMBIGUOUS_TARGET`、`PROTECTED_FILE`、`SCOPE_VIOLATION`。

`asWorkspaceResult()` 在 RPC 或函数式边界把异常转成 `WorkspaceResult`;
**核心类内部不重复做 DTO 转换**。

## 本地开发与门

```bash
bun run --cwd packages/workspace build
bun run --cwd packages/workspace check       # build + typecheck + lint + check:arch + test
bun run --cwd packages/workspace preflight   # check + test:eval
```

`check:arch`(= `scripts/check-architecture.mjs`)已挂进仓根 `check:gates`,
锁「本仓只有一个独立 `@velaros-ai/workspace` 包」与 Workspace 自有的 Agent adapter 契约 / 宿主能力边界。

## 更多文档

- [架构](docs/ARCHITECTURE.md) · [VelarOS 集成](docs/VELAROS_INTEGRATION.md) · [Agent 协议](docs/AGENT_INTEGRATION.md)
- [JS/TS 插件](docs/JSTS_PLUGIN.md) · [批处理并发](docs/BATCH_CONCURRENCY.md) · [插件编写](docs/PLUGIN_AUTHORING.md)
- [生产就绪度](docs/PRODUCTION_READINESS.md)

> 这些是并仓前随包带来的历史文档,**英文、未逐条修实**,与本 README 冲突时以本 README 与代码为准。

## 兼容策略

保持 1.x 公共入口、工具名与事务语义兼容。符号结果新增了规范的 `range`,
同时保留原顶层 line / column 字段。破坏事务状态机、错误码或工具 schema 的变更需要新主版本。
