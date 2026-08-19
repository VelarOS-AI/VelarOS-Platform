# @velaros-ai/agent

> **位置**:VelarOS-Platform 单版本火车 · `agent` 域唯一包 · 目录 `packages/agent`。
> 它是**宿主无关的 Agent 执行运行时**,被 Desktop 一类宿主装配消费;它自己不是应用,也不是内核
> ——内核库本体在 `@velaros-ai/kernel`。

## 这个包解决什么问题

让模型**稳定地把活干完**:一轮对话要装配提示词、挑可用工具、执行工具、把结果塞回上下文、
在上下文撑爆前降级、把整条执行链记成可回放的账本、必要时派子 agent 并行干活。

这些机制与「具体能力是什么」正交——本包只提供机制,**不认识**浏览器、工作区、记忆、办公文档
这些领域名词。领域能力由能力包实现,经端口注入。

这条「机制与领域分离」是本包最重要的设计判决:运行时里**不许出现产品或能力的名字**。
想让 agent 会一件新事,做法是写一个能力包 + 在装配根注入,而不是在这里加
`if (toolName === 'browser:act')`。

## 对外分区

| 子路径 | 一句话职责 |
| --- | --- |
| `@velaros-ai/agent` | 运行时主干:循环、上下文、提示词、工具注册与执行、执行账本、子 agent 派发、技能、mod 装载 |
| `@velaros-ai/agent/node` | **仅 Node Host**：工具目录 revision、租约校验、schema 自恢复与单调用执行门面；Node 内建模块不会进入 browser-safe 子路径 |
| `@velaros-ai/agent/chat` | **browser-safe** 聊天客户端公共面:会话投影、搜索、上下文用量与回合环境格式化 |
| `@velaros-ai/agent/chat-stream` | 聊天流协议与消费者(`ChatStreamProtocol` / `ChatStreamConsumer` / 会话流日志) |
| `@velaros-ai/agent/run-context` | 回合上下文账本与追加通道，供能力适配器接入，不暴露 Agent 根运行时 |
| `@velaros-ai/agent/tool-contract` | 工具定义、审批端口、描述构造与 schema 辅助，只承载 Agent 工具契约 |
| `@velaros-ai/agent/protocol` | **版本化 wire 契约**(zod schema + 推导类型),跨进程 / 跨版本传输用 |
| `@velaros-ai/agent/protocol/{agent-capability,execution,message,session,lease,mods,observability,external-agent-bridge}` | 按契约族细分的按需入口 |

**为什么 protocol 单独切出来**:它只描述数据形状与 browser-safe 边界校验,不含 Node 或执行编排。一个只想解析
Agent 消息帧的进程(RPC 前脸、日志分析、外部桥接)不该被迫吃进整个执行运行时。
协议对象以严格 schema/解析器拒绝未知字段；需要 `node:crypto` 或 ToolExecutor 的实现单独留在 `/node`。

## 核心概念

**回合与循环**。`runAgentLoop` 驱动一次完整回合;`AgentRunner` 把模型端口、上下文与工具执行
组合成运行门面;`QueryLoop` 是面向查询型任务的另一种循环策略。回合开始时**冻结一份能力快照**,
同一回合内 provider 请求与工具执行看到同一修订,避免中途换脚。

**上下文治理**。`ContextBuilder` 装配分段上下文;`ContextDegradeLadder` 在逼近窗口上限时按阶梯
降级(`resolveContextDegradeAction`);`ContextUsageCalibrator` 校准 token 估算与实测的偏差;
`ContextEvidenceLedger` 记住哪些工具结果构成证据。**上下文压不下去不是靠一刀截断**,而是这条阶梯。

**工具**。`ToolRegistry` 持有目录快照,`ToolExecutor` 是**唯一执行路径**(权限、schema 校验、
结果归一都在这一条路上)。`src/tool-library/` 是 host 无关的通用工具集合——`agent:dispatch`、
上下文召回与蒸馏、目标 / 计划、后台任务、工作流等**机制类**工具住这里;浏览器点击、文件编辑那种
**领域类**工具住各自能力包。

**能力注入**。`AgentRuntimeCapabilityPorts` 是领域能力接进来的总入口:

- `resultMiddlewares` 后处理能力自己的工具结果;
- `validationHintProviders` 解释能力自己的 schema;
- `allocation` 把宿主定义的操作映射到类别与前置条件;
- `promptContributors` 贡献能力相关的运行时指引;
- `contextCollectors` / `intentClassifiers` / `evidenceExtractors` 把领域解释留在能力包里;
- `validationInterpreters` 拥有能力自己的验证逻辑;
- `scopePolicy` 拥有产品作用域与驻留语义(**同时只允许一条生效**,组合出多条会直接抛错);
- `delegationPolicy` 声明哪些工具 / 类别不许下放给子 agent;
- `toolAliases` 处理能力自己的兼容名。

**端口缺席 = 行为缺席**,运行时不给任何领域默认值,也不解释上面任何一个 id。

**执行账本与可观测性**。`ExecutionService` 管一次执行的生命周期并防同 scope 并发冲突;
`src/kernel/observability/` 把回合拆成 span 树落盘(`run` / `turn` / `model` / `tool` /
`capability` / `policy` 六类),消费方是宿主的 span 账本。

**最终请求可重建**。请求编译器在 provider 边界生成 `ProviderRequestSnapshot`，保存模型实际
看到的 alias、改写后 system、消息、工具描述与精确 schema、tool choice 及 fingerprint，但不保存
密钥、client 或执行函数。真正发送前会核对可见工具与快照能否一一重建；schema 缺失或工具面漂移
会以不变量错误拒绝发送。fingerprint 同时绑定最终 system、消息内容与工具 schema hash，不能用
“角色序列相同”冒充“请求相同”。无密钥 fixture 覆盖这条边界。

Prompt audit sidecar 可保存完整快照供本机诊断，但它不是 session authority。它可能含有用户与模型
内容，宿主必须遵守保留策略，并在导出前脱敏。`describeRunProfiles()` 只读暴露 compact、balanced、
expanded 的预算及自动选择阈值，用于解释运行行为，不提供覆盖权限、工具执行或 Kernel 策略的入口。

**子 agent**。`SubAgentDispatcher` 派发并发子任务;结果回填父会话时带来源前缀,防止并行结果串台。

**mod 两级注册机的第二级**。`AgentModLoader` 按 manifest 装载九条贡献轴,`AgentModSeamDispatcher`
派发拦截钩子,`assembleAgentMods` 是宿主把 Kernel pack 清单接进来的入口。
**贡献轴是封闭集合**,由官方演进,mod 只能挂接不能发明。落地细节见
[`docs/agent/agent-mod-trunk.md`](../../docs/agent/agent-mod-trunk.md)。
`src/kernel-module.ts` 是**第一级**边界:它把 Agent 运行时当作不透明的注入物交给 Kernel,
自己从不解析领域 manifest。

## 典型用法

装配运行时的最小形状——注入能力端口、给出中性的主 Agent 身份:

```ts
import {
  type AgentRuntimeCapabilityPorts,
  ContextBuilder,
  createBuiltInPromptRegistry,
  MonotonicExecutionIdFactory,
} from '@velaros-ai/agent'

// 提示词目录:主 Agent 身份由宿主注入,包内默认刻意保持产品中性
const prompts = new ContextBuilder(createBuiltInPromptRegistry({
  primaryAgentIdentity: '你是 Acme 应用中的研究助手。',
}))

// 领域能力经端口注入,运行时不解释这些 id
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

// 执行 ID 工厂:默认随机命名空间,多运行时共用存储也不撞
const ids = new MonotonicExecutionIdFactory()
```

只消费 wire 契约(不拉运行时):

```ts
import { RunTurnRequestSchema } from '@velaros-ai/agent/protocol/execution'

const request = RunTurnRequestSchema.parse(payload) // 严格对象,未知字段直接拒
```

## 边界:本包不负责什么

- **不是装配根**。谁来实例化、谁持有生命周期,是宿主的事。
- **不实现模型供应商**(去 `@velaros-ai/model`)、**不实现记忆 / 知识存储**(去 `@velaros-ai/memory`)、
  **不实现浏览器 / 工作区 / 办公 / 桌面控制**(去各能力包)、**不做 UI**(去 `@velaros-ai/ui`)。
- **不拥有 Electron、产品 IPC、Desktop 配置、渲染进程代码、应用私有 manifest**。
- **没有可变全局注册表**。一个应用运行时拥有自己的 registry / store / service / ID factory;
  需要确定性 ID 就实现 `ExecutionIdFactory`,需要确定性时间就给 `MonotonicExecutionIdFactory` 注入时钟。
- Agent surface 由产品注入(`AgentSurfaceProfileProvider`),运行时无全局 surface 注册表、无内置兜底。
- `SkillMarketClient` 在宿主注入 `marketBase` 之前**保持禁用**,没有内置端点,也不读环境变量。

## 与相邻包的关系

```
@velaros-ai/core            ← 唯一上游:AppError、kernel ABI、通用工具
        ↓
@velaros-ai/agent           ← 本包:执行机制
        ↑ 经 AgentRuntimeCapabilityPorts 注入
@velaros-ai/{browser,project,development,computer,memory,office,system,cli,game}
                              领域能力包:提供工具与领域解释,自己不认识 agent 循环
```

- **能力包不许被本包 import**,方向恒为「能力包被注入」。
- 与 `@velaros-ai/memory` 之间**只有三个端口**(证据采集 / 回合召回 / Dream 调度),胶水住
  `@velaros-ai/memory/adapter-kernel`;本包持有**零个** memory import。
- 宿主(VelarOS-Desktop)在自己的装配根组合本包 + 能力包 + 模型包。

## 错误模型

统一用 `@velaros-ai/core/error` 的 `AppError` + 稳定错误码:可选宿主能力未配置 → `UNAVAILABLE`,
输入错误 → `VALIDATION`。provider / 工具 / 协议错误**在边界处归一一次**,内部继续传规范形态。
Abort 信号表示取消,**不要**转成普通失败后重试。

## 兼容策略

公共类型的破坏性变化按 SemVer 升主版本;新增构造参数必须可选或带默认实现。
`protocol` 同一主版本内只做向后兼容扩展——改字段含义、删字段、收紧已接受输入都要升协议主版本。
**内部目录不属于兼容承诺**,消费者只依赖 `package.json#exports` 声明的入口。
