# `@velaros-ai/agent-runtime` 中文接口文档

## 定位与非目标

本包是宿主无关的 Agent 执行运行时，负责循环、提示词装配、上下文治理、工具注册与执行、执行账本、团队调度和工作流。它不是应用装配根，不实现模型供应商、存储产品、浏览器、工作区、知识库或 UI。

## 安装

```bash
npm install @velaros-ai/agent-runtime
```

包为 ESM，要求 Node.js 20 或更高版本。具体能力包由应用自行安装并注入。

从 `0.4.2` 起，发布声明不再引用 Core 的 ambient 类型，也不发布自己的全局类型；
声明所需的辅助别名使用包内私有模块类型，因此可以与 Core、UI 和其他 VelarOS
包在同一严格 TypeScript 项目中安装。

## 公共入口

当前稳定入口为 `@velaros-ai/agent-runtime`。根入口按领域导出 `agent`、`capabilities`、`execution`、`kernel`、`prompts`、`skills`、`team`、`tools` 和 `workflow` API。不要导入源码或 `dist` 私有路径。

## 核心类与接口

- `SoloLoop`、`QueryLoop`：面向不同执行策略的循环实现。
- `AgentRunner`：组合模型端口、上下文和工具执行的运行门面。
- `ExecutionService`、`ExecutionStore`：执行生命周期与账本。
- `ToolRegistry`、`ToolExecutor`：工具目录快照与唯一执行路径。
- `AgentWorkflowRuntime`：受约束工作流执行器。
- `AgentRuntimeCapabilityPorts`：领域能力注入总入口。
- `MonotonicExecutionIdFactory`：实例隔离、时钟与命名空间可注入的执行 ID 工厂；默认使用随机命名空间，多个运行时共用存储时也不会冲突。
- `createBuiltInPromptRegistry`：创建中性的内置提示词目录；宿主通过 `primaryAgentIdentity` 注入自己的 Agent 身份。
- `SkillMarketClient`：可选技能市场客户端；端点完全由宿主注入，未配置时保持禁用。

公共类承担状态、不变量和生命周期；文本裁剪、排序、验证等无状态算法保持纯函数。

## 生命周期/并发

一个应用运行时应拥有自己的 registry、store、service 和 ID factory。每个 Agent turn 会冻结能力快照，provider 请求与工具执行使用同一修订。`ExecutionService` 防止同一 source scope 并发运行冲突；结束时必须清理队列、订阅和 abort controller。

## 依赖注入

通过构造参数或 `AgentRuntimeCapabilityPorts` 注入：

- 模型执行与流式输出端口；
- 工具与能力扩展；
- 权限审批、认证和活动信号；
- 资源/作用域解析；
- 存储路径、协作和可观测性。
- 主 Agent 身份和可选技能市场端点。

运行时没有可变全局 registry。需要确定性 ID 时，实现 `ExecutionIdFactory`；需要确定性时间时给 `MonotonicExecutionIdFactory` 注入 `ExecutionClock`。

```ts
import {
  ContextBuilder,
  createBuiltInPromptRegistry,
  SkillFileStore,
  SkillMarketClient,
} from '@velaros-ai/agent-runtime'

const prompts = new ContextBuilder(createBuiltInPromptRegistry({
  primaryAgentIdentity: '你是 Acme 应用中的研究助手。',
}))

const skillStore = new SkillFileStore({
  skillsDir: () => new URL('./skills', import.meta.url).pathname,
})
const market = new SkillMarketClient({
  store: skillStore,
  marketBase: () => 'https://downloads.example.com/acme-skills',
})
```

`SkillMarketClient` 不读取 Desktop 仓库地址或环境变量作为默认端点。未传
`marketBase` 时，`getAvailability()` 返回 `endpoint-not-configured`，目录读取以
`AppError('UNAVAILABLE', 'skill-market-disabled')` 失败，并且不会发起网络请求。

## 错误模型

编程不变量使用 `AppError` 及稳定错误码；provider、工具与协议错误在边界处归一一次，内部继续传递规范形态。未配置的可选宿主能力使用 `UNAVAILABLE`，输入错误使用 `VALIDATION`。Abort 信号表示取消，不应被转成普通失败后重复重试。

## 最小第三方示例

```ts
import type {
  AgentRuntimeCapabilityPorts,
  ExecutionClock,
} from '@velaros-ai/agent-runtime'
import { MonotonicExecutionIdFactory } from '@velaros-ai/agent-runtime'

const capabilities: AgentRuntimeCapabilityPorts = {
  extensions: [{
    descriptor: {
      id: 'acme.documents',
      operationIds: ['read-document'],
      categoryIds: ['documents'],
    },
    allocation: {
      operationCategories: { 'read-document': ['documents'] },
    },
  }],
}

const clock: ExecutionClock = { now: () => Date.now() }
const ids = new MonotonicExecutionIdFactory(clock)
// 将 capabilities、ids 及模型/权限/存储端口注入应用自己的 composition root。
```

## 扩展点

能力扩展可贡献提示词、上下文、意图、结果中间件、验证解释、作用域策略和工具别名。新的领域规则应加入能力包，再通过这些端口注入；不要在 Agent Runtime 中枚举产品或能力名称。

声明式扩展走 mod 主干（两级注册机的第二级，见仓库 `docs/agent-mod-trunk.md`）：`AgentModLoader` 按 manifest 装载九条贡献轴，`AgentModSeamDispatcher` 派发拦截钩子，`assembleAgentMods` 是宿主把 Kernel pack 清单接进来的入口。贡献轴与钩子都是封闭集合，由官方演进，mod 只能挂接不能发明。

## 兼容策略

保留现有公共类、接口和别名；新增构造参数必须可选或提供默认实现。公共类型的破坏性变化按 SemVer 提升主版本。内部目录不属于兼容承诺，消费者只依赖根 `exports`。
