# packages/agent 按仓库标准改造方案

> 对象：`~/Desktop/VelarOS/projects/VelarOS-Platform/packages/agent`（`@velaros-ai/agent` 0.6.30）。分析从 HEAD `05796fd` 开始，期间另一个实例提交到 `7c0bbf8`，其中 `8d7513e` 改了 `src/agent/LoopRuntime.ts` 并加了 1 个测试；本文数字已按 `7c0bbf8` 重算。
> 标准：`docs/architecture/module-ownership.md`、ADR 0003 / 0007、样板 `packages/system`、门禁 `scripts/ownership/check-module-ownership.mjs` 与登记表 `scripts/ownership/governed-modules.mjs`。
> 方法：只读分析。数字全部来自脚本实测（TypeScript AST + 类型检查器解析到声明文件；消费方扫描覆盖 Platform 的 `packages/*`、`tests/`、`scripts/`、`products/`，另加姊妹仓 Desktop、Workbench、Termel、Extension，跳过 `scratchpad/`、`node_modules`、`dist`）。
> 基线：`packages/agent` 下 `bun test test` 现在是 830 pass / 0 fail（117 个文件，3.1 秒；你给的 829 是 `8d7513e` 之前的数），agent 目录工作区干净。注意：`scripts/ownership/governed-modules.mjs` 有另一个实例未提交的改动（把 project 登记进治理），本方案不碰它，但第 7 步要在它提交之后再登记 agent。

## 0. 结论先行

1. **规模**：`src/` 431 个 `.ts`（外加 `velaros-globals.d.ts`），89,069 行，54 个目录；164 个类（另 8 个错误类），其中只有 17 个类 `implements` 接口；45 个 `index.ts`（15 个是入口、29 个是中间转发、1 个是 1,432 行的真内容）；23 个对外入口共导出 2,951 个符号（按声明去重 2,263 个）。
2. **真正被用到的对外符号只有 604 个（27%）**：Platform 仓内生产代码与测试用 47 个，Desktop 507、Workbench 125、Termel/Extension 81。`./host`、`./runtime`、`./remote`、`./protocol/{execution,lease,message,mods,observability,session}` 八个入口零消费方。
3. **目标**：`src/` 收成 `contract/ types/ impl/ utils/ exports/` 五个目录。impl 167 个文件（工具文件 1、类文件 158、错误类 8），分 19 个域子目录、13 层；utils 约 270 个文件（默认一个来源文件对一个 utils 文件，保持原有的类别划分），分 22 个域子目录；types 22 个文件，其中 `types/agent.ts` 是可移植数据文件；入口从 23 个收成 4 个：`.`、`./contracts`、`./chat`、`./tool-contract`。
4. **分层可行**：把每个 import 穿过 barrel 解析到真正声明它的文件后，文件级的值依赖图没有环（现在的模块图有环，全是 barrel 与包名自引用造成的，1.6 节的 TDZ 报错就是其一）；按本方案的域划分，类到类的依赖在调整 4 个类的去处之后，**零处下层引上层**（第 2.3 节）；要改成「收接口」或改成类的顶层函数只有 24 个（第 4.3 节）。
5. **要拍板的结构冲突有 6 处**（第 3.5 节）：zod 先行的协议类型与「types 零值、只引 types 与合同」冲突；可移植文件只能一个且不许 import；六个空间包把 `./tool-contract` 当写工具的 SDK 用（是否独立成包）；门禁的宿主端口检查写死了 `ctx.system`；入口名不能带 `/`；收口是破坏性变更，`check:agent-public-api` 要求主版本号 +1，即 agent 1.0.0。
6. **顺序**（第 6 节）：先做门禁与脚本准备 → 去自引用与去 barrel（行为不变）→ 整文件搬家 → 拆混合文件 → 合同与接口 → 工具文件 → 入口收口（1.0.0 与迁移表）→ 登记治理。每一步都能保持 830 条测试全过；前五步不改任何对外入口与符号，Desktop 不受影响。

## 1. 现状摘要

### 1.1 目录与职责

| 目录 | 文件 | 行 | 职责 |
| --- | ---: | ---: | --- |
| `src/`（根） | 3 | 195 | `index.ts` 通配转发 19 个子目录；`kernel-module.ts` 把注入的 Agent 运行时包成 Kernel 模块；`velaros-globals.d.ts` |
| `agent/`（根） | 51 | 13,199 | 回合循环：唯一引擎 `runAgentLoop`（AgentLoop）与两个薄壳 `SoloStreamLoop`（主会话）、`QueryLoop`（子 agent）；回合 `StreamTurn`/`QueryTurn`/`TurnRunner`；Solo 的收尾闸门与续跑（`SoloFinishingGate`、`SoloBackgroundCompletionGate`、`SoloTurnWindDown`、`SoloToolUseContinuation`…）；会话工作态 `CodingSessionTracker`（1,416 行）；角色、运行档、执行限制、重试 |
| `agent/context/` 及 `providerRequest/` | 26 | 4,195 | provider 请求编译（`ProviderRequestCompiler`，第一环六阶段管线 + 出核地板）、上下文用量与预算、工作集分区、载荷句柄 `ContextPayloadStore` |
| `agent/context/residency/` | 19 | 5,915 | 上下文治理 v2：只追加的驻留账本 `ContextResidencyLedger`、会话级治理器 `ContextGovernanceSession(Registry)`、治理周期、准入、锚点、骨架、蒸馏、投影、仪表盘 |
| `agent/context/resources/` | 6 | 1,136 | 文件上下文：`FileContextCoordinator`、快照归档、投影 |
| `agent/context/retrieval/` 及 `search/` | 14 | 4,341 | 召回：`ChatContextRetrievalService`（1,351 行）、索引、载荷读取、引用读取、排序 |
| `agent/control-plane/` | 7 | 1,490 | 每回合的运行计划（意图、能力、上下文、提示词、恢复）与会话工具分配 `SessionToolAllocator` |
| `agent/history/` | 9 | 2,469 | 发给 provider 前的历史清洗、校验、孤儿自愈 |
| `agent/model/` | 7 | 603 | 模型请求端口（AI SDK 适配）、提示词缓存、输入模态兼容、错误归一 |
| `agent/run-context/` | 6 | 870 | 系统提示词组装 `RunContext`、回合上下文载荷、环境回合上下文账本 `TurnContextLedger` |
| `agent/runner/` | 11 | 1,480 | 运行门面 `AgentRunner`、默认执行栈 `createAgentExecutionStack`、宿主端口类型、目标生命周期投影 |
| `agent/stream/` | 14 | 3,119 | 流消费 `StreamConsumer`（1,126 行）、工具入参增量解析、内联思考标签、泄漏标记过滤、空流与截断恢复 |
| `kernel/`（根） | 14 | 3,582 | 名为 kernel、实为 Agent 自己的会话控制面：后台任务 `KernelBackgroundJobManager`、会话输入准入与运行权 `session-lane`、控制器、provider 回合事件归约、上下文纪元、前缀形状、工具死循环守卫、工具输出句柄化 |
| `kernel/{bridge,dispatch,execution,observability,session-store}/` | 36 | 7,567 | 聊天↔会话通道 `ChatKernelSessionBridge`；子 agent 派发 `SubAgentDispatcher`（1,840 行，全包最大）；执行服务 `ExecutionService` 与事件总线；span 观测账本与提示词审计；会话树账本 `SessionStore` |
| `execution/` | 17 | 3,571 | 执行记录：`ExecutionStore`、`ExecutionRecords`、交互、引导队列、计划/任务账本、路由、状态机 |
| `tools/`、`tools/recovery/` | 26 | 7,650 | 工具执行链：`ToolExecutor`（1,618 行，唯一执行路径）、`ToolExecutionPolicy`（策略与审批门）、参数校验、传输名、结果序列化、工具空间可见性、入参复用与失败恢复 |
| `tool-contract/` | 14 | 2,120 | 写工具的 SDK：`defineToolRuntimeSpec`、说明结构与渲染、schema 打包、输入边界、审批端口、交互端口 |
| `tool-library/`（含 `builtin/ context/ mcp/ network/`） | 43 | 8,033 | 内置模型面工具 19 个（`*.tool.ts`）与其实现；工具上下文 `KernelToolContext`；MCP 连接与翻译；SSRF 安全门 |
| `protocol/`（含 `constants/ types/`） | 28 | 5,963 | 版本化 wire 契约：zod schema 与推导类型、聊天与执行数据模型（`types/index.ts` 1,432 行）、协议常量 |
| `mods/` | 8 | 2,670 | mod 两级注册机第二级：装载器、注册表、拦截 seam、投影、宿主组装、内置 mod、`.velarmod` 导入 |
| `prompts/`、`skills/`、`reminders/` | 16 | 2,626 | 提示词段注册表与内置段目录；技能仓库与文件技能；运行时提醒调度 |
| `sub-agent/`、`team/`、`workflow/` | 11 | 1,688 | 子 agent 结构化输出、线程存储、类型注册；团队模型路由与写租约；声明式工作流解释器 |
| `session/` | 9 | 958 | 产品 Session 应用服务：Goal/Plan/Question/Permission、租约、归档（只有 Termel 在用） |
| `chat/`、`chat/stream/` | 11 | 991 | 渲染侧聊天流协议与消费、消息投影 |
| `bridge/`、`remote/`、`node/`、`coding/`、`capabilities/`、`execution-modes/`、`host/`、`runtime/` | 26 | 2,647 | 外部 agent 桥、远程节点、Node 工具契约门面、编码验证、能力扩展解析、执行模式、两个稳定子路径入口 |

### 1.2 子系统怎么串起来

- **一次主会话回合**：宿主经 `ChatKernelSessionBridge` 或 `SoloExecutionService` 进 `ExecutionService`（会话互斥、待输入/待确认、持久化）→ `AgentRunner` → `SoloStreamLoop` → 引擎 `runAgentLoop` → `TurnRunner` → `StreamTurn`（`ProviderTurnRequestHelper` 组请求、`ProviderRequestCompiler` 编译、`AiSdkAgentModelRequestPort` 发送、`StreamConsumer` 消费）→ 工具调用进 `ToolExecutor`（seam → 可用性与参数 → `ToolExecutionPolicy` 审批 → 执行 → 结果中间件 → `finalizeResult`）→ 结果进驻留账本 → 下一轮。
- **上下文**：`RunContext` + `PromptStateBuilder` + `ContextBuilder` 组系统提示词（段来自 `PromptRegistry` 与能力注入的 `CapabilityPromptContributor`）；历史经 `history/` 清洗后进 `ContextGovernanceSession` 的账本，按驻留态投影。
- **子 agent**：工具 `agent:dispatch` → `ctx.dispatchSubAgent` → `SubAgentDispatcher`（并发闸、类型路由、模型路由、写租约）→ `QueryLoop`；异步派发登记成 `KernelBackgroundJobManager` 的后台任务，完成后经会话通道回灌。
- **能力注入**：领域能力只经 `AgentRuntimeCapabilityPorts`（`capabilities/CapabilityExtensions.ts`）进来：结果中间件、校验提示、分配元数据、提示词贡献者、上下文收集器、意图分类器、验证解释器、作用域策略、委派策略、工具别名。

### 1.3 对外入口：导出了什么、谁在用

统计口径：「导出」来自 `baselines/agent/public-api.json`（与 `check:agent-public-api` 同源）；「被用」指至少一个消费方文件 import 了该名字。

| 入口 | 导出 | 被用 | 其中仓内 | 消费方（文件数） | 判定 |
| --- | ---: | ---: | ---: | --- | --- |
| `.` | 1,607 | 252 | 12 | Desktop 112、Workbench 30、`packages/project` 9（全在 test/）、Termel 4、`scripts/agent/check-schemas.mjs` 1 | 兼容聚合，84% 没人用 |
| `./protocol` | 644 | 250 | 7 | Desktop 290、Workbench 28、agent 自己的 test 8、Termel 7、project 4、system 4、browser 3、computer 2、office 1 | 主要是类型；172 个值只用了 33 个 |
| `./tool-contract` | 93 | 36 | 27 | project 25、browser 22、Desktop 16、Workbench 10、office 8、system 7、memory 6、Termel 4、computer 3、scripts 2 | 六个空间包写工具的 SDK |
| `./host` | 92 | 0 | 0 | — | README 推荐的「稳定宿主面」，零消费 |
| `./mods` | 81 | 7 | 0 | Desktop 1、Workbench 1、Termel 1 | |
| `./chat` | 63 | 15 | 0 | Desktop 16、Workbench 2 | 渲染进程入口 |
| `./protocol/mods` | 52 | 0 | 0 | — | 零消费 |
| `./session` | 49 | 29 | 0 | Termel 6 | 只有 Termel |
| `./protocol/session` | 44 | 0 | 0 | — | 零消费 |
| `./protocol/external-agent-bridge` | 30 | 3 | 0 | Desktop 1 | |
| `./runtime` | 29 | 0 | 0 | — | README 推荐的「稳定运行面」，零消费 |
| `./run-context` | 23 | 2 | 2 | browser 2、memory 1 | 只用了 `TurnContextSessionLedgers`、`TurnContextAppendBus` |
| `./protocol/observability` | 21 | 0 | 0 | — | 零消费 |
| `./protocol/lease` | 20 | 0 | 0 | — | 零消费 |
| `./mcp` | 19 | 10 | 0 | Desktop 4、Termel 1 | |
| `./protocol/execution` | 18 | 0 | 0 | — | 零消费 |
| `./bridge` | 16 | 6 | 0 | Desktop 1、Termel 1 | |
| `./chat-stream` | 11 | 3 | 0 | Desktop 6 | 与 `./chat` 重复（`./chat` 已 `export *` 它） |
| `./remote` | 11 | 0 | 0 | — | 零消费 |
| `./protocol/agent-capability` | 10 | 7 | 0 | Workbench 5、Desktop 3 | |
| `./protocol/message` | 9 | 0 | 0 | — | 零消费 |
| `./node` | 6 | 4 | 0 | Desktop 2 | |
| `./remote/mcp` | 3 | 1 | 0 | Termel 1 | |

各入口里有什么（源文件在 `src/` 下对应目录的 `index.ts`，`./protocol/*` 八个直指 `protocol/<名>.ts`）：

- `.`：`src/index.ts` 通配转发 19 处（agent、capabilities、chat、coding、execution、execution-modes、kernel、kernel-module、mods、prompts、reminders、skills、sub-agent、team、tool-contract、tool-library、tool-library/mcp、tools、workflow），等于把包内几乎所有东西连同 48 对别名一起出包。
- `./runtime`：`createAgentExecutionStack` 与其选项类型、`resolveAgentExecutionLimits`/`DefaultAgentExecutionLimits`、运行档（`RunProfileDefinitions`、`describeRunProfiles`、`resolveRunProfile*`）、`AgentRunLifecycle` 一族、三种运行配置类型、`MonotonicExecutionIdFactory`、`createBuiltInPromptRegistry`/`PromptRegistry`。
- `./host`：模型端口（`AgentModelResolverPort` 等 6 个）、`AgentSurfaceProfile*`、`agent/runner/host-ports.ts` 的全部类型、`AgentRuntimeEvents`、`AgentRuntimeInputPort` 与中断作用域工厂、`capabilities/` 的全部类型、`createAgentKernelModule` 与 `AgentCapability` 等身份。
- `./node`：`ToolContractExecutionFacade` 与其类型、`ToolContractDiscoveryDescriptors`。
- `./chat`：上下文用量估算、回合上下文格式、目标生命周期投影、执行模式解析、工具结果序列化、`ChatMessageHelper`、发送请求解析、存储会话字段解析、谱系与搜索文本，并 `export *` 了 `./chat-stream`。
- `./chat-stream`：`ChatStreamConsumer`、`ChatStreamProtocol`/`chatStreamProtocol`、`ChatStreamSessionLog` 与流类型。
- `./run-context`：`RunContext`/`AgentRunContextHelper`、回合上下文格式、`TurnContextLedger` 三件套、`TurnPayload`。
- `./protocol`：全部 wire schema 与类型（`protocol/types/` 13 个文件、会话树 entry、mod 清单、span、租约、执行动词、外部桥消息、类型断言函数、协议常量）；`./protocol/*` 八个是其中各族的子集。
- `./tool-contract`：工具定义与说明渲染、schema 打包、输入边界、审批与交互端口、任务审批、示例登记、概念、发现描述、身份、宽容 schema，外加 `fileContextFor`、`FileContext*`、`ToolInputReuse` 三件。
- `./mcp`：`McpClientConnection`、`McpAuthorizationRequiredError`、两个超时常量、`translateMcpTool`/`convertMcpInputSchema`/`buildMcpToolName`、`translateMcpCallResult`。
- `./mods`：宿主组装、Loader、投影、注册表、seam 派发、内置 mod、`.velarmod` 导入器。
- `./bridge`：回环服务与三个状态机类、上限常量、令牌比较。
- `./session`：产品 Session 的归档、契约与 schema、事件端口、Goal/Plan/Question 服务、租约与权限函数。
- `./remote`：`RemoteHostService`、`createRemoteHostTool`、契约；`./remote/mcp`：`createRemoteNodeMcpServer`、`runRemoteNodeMcpStdio`。

仓内值级用法（决定收口时哪些必须留在公开面）：

- 六个空间包（system、project、browser、office、memory、computer）从 `./tool-contract` 用 `defineToolRuntimeSpec`、`renderParameterDescription`（browser 19 处）、`structureToolDescriptionsForCategory`、`createApprovalOperationKey`、`createManualApprovalOptions`、`defaultDenyApprovalPort`、`withToolInputReuse`、`resolveToolInputReuse`、`fileContextFor`、`schemaToInputSchema`、`createToolSchemaBundle`、`canonicalizeProviderInputSchema`、`isCanonicalToolId`、`DefaultToolContractExampleRegistry`、`ToolInputBounds` 的 6 个函数，类型 `ToolContractRuntimeSpec`、`DefineToolRuntimeSpecInput`、`ToolContractSurface`、`ApprovalPort`、`FileContext*`；从 `./protocol` 只用类型 `AgentModManifest`、`ToolCategoryDefinition`、`ToolPermission`、`ToolCapabilitySchema`、`ToolCategoryId`、`ToolExecutionApi`、`ToolResultModelContentPart`。
- browser、memory 从 `./run-context` 用 `TurnContextSessionLedgers` 类与 `TurnContextAppendBus` 类型。
- project 的 9 个测试从根入口直接用内部件做集成测试：`ProviderRequestCompiler`、`InMemoryContextPayloadStore`、`ContextGovernanceSessionRegistry`、`compileProviderSendRequest`、`ToolExecutor`、`ToolExecutionPolicy`、`AgentTurnHistoryHelper`（弃用别名）、`fileContextFor`。
- `scripts/agent/check-schemas.mjs` 用根入口的 `AgentWorkflowRuntime`、`agentWorkflowSchema`；`scripts/capabilities/check-schemas.mjs` 用 `createToolSchemaBundle`。

**绕过入口直接引 agent 源码的地方**（违反「包与包不互相引用源码，测试也不行」，也是搬家时最容易漏的）：

| 位置 | 引了什么 |
| --- | --- |
| `packages/project/scripts/model-guidance-audit.ts:1-20` | 12 处 `../../agent/src/...`（`AppRuntimeFacts`、`FileContextProjection`、`prompts/catalog`、`prompts/registry`、`segments/runtime`、`tool-contract/examples`、`schema-bundle`、三个 `*.tool.ts`、`ToolArgsSchemaValidator`），第 40–43 行还以字符串写死 14 个 agent 源文件路径；`packages/project/test/project-guidance-drift.test.ts` 依赖它；指纹存在 `docs/engineering/project-model-guidance-review.json`（登记了 15 个 agent 源文件） |
| `tests/capabilities/tool-operation-approval.test.ts:10-12` | `CodingSessionTracker`、`ApprovalPort`、`createTaskApprovalPort` 的源文件路径 |
| `scripts/mod/velaros-mod.mjs:8` | `packages/agent/src/protocol/mods.ts` 的 `parseAgentModManifest` |
| `scripts/agent/check-conversation-semantics.mjs:9` | `packages/agent/src/protocol/types/index.ts` |
| `scripts/agent/check-browser-surface.mjs:10-13` | 四个入口源文件路径 |
| `scripts/agent/check-arch-boundaries.mjs:262-535` | 按路径钉了约 25 个 agent 源文件与其中的标记串（防线④⑤⑦） |

### 1.4 与别的包的耦合

- **依赖**（按 import 次数）：`@velaros-ai/core` 400（根 230、`/error` 86、`/logger` 41、各 utils 43）、`ai` 80、`zod` 34、`@velaros-ai/kernel` 11（`contracts/abi` 1、`contracts/protocol` 6、`remote/client` 4）、`@modelcontextprotocol/sdk` 10、`gpt-tokenizer`、`jszip`、`ws` 各 1；Node 内置模块出现在 34 个文件。`package.json` 里 `execa`、`typescript`、`@types/json-schema` 三个运行时依赖**代码里一处没用**，可删。
- **自引用**：`src/` 里 162 个文件、204 处经包名引用自己（`@velaros-ai/agent/protocol` 165、`/tool-contract` 21、根入口 18），靠 `tsconfig` 的 `paths` 指回 `src`。根入口的 18 处会把整个聚合入口拉进来。改造第一步就要把它们改成指向声明文件的相对路径，否则门禁的分层检查看不见这些依赖，`move-files.mjs` 也不会改写它们。
- **被依赖**：六个空间包把 `@velaros-ai/agent` 列为 peerDependency，只为写工具；它们经 `node_modules` 软链读 agent 的 `dist`，所以 agent 内部搬家不影响它们，入口名和符号变了才影响。
- **写死的空间/宿主/厂商知识**：见 1.5。

### 1.5 写死了具体空间/宿主/厂商知识的地方

`check:agent-arch` 防线⑤已经禁掉 browser、workspace、workbench、memory、knowledge、computer、工作区、浏览器、记忆这些词，实测命中 0。漏网的全部集中在它没禁的 `project`、`system:`、`office`、`html-artifact`/`widget`、Desktop 宿主 DTO、厂商名、角色 id 上。行号以 `7c0bbf8` 为准。

**P0：必须搬走（写在发请求主链上，或者直接认具体空间的数据形状）**

| # | 位置 | 写死了什么 | 谁在用 | 去处与需要的中立扩展点 |
| --- | --- | --- | --- | --- |
| P0-1 | `src/tools/projectReadSerialization.ts:7-38,129-156`；`agent/context/resources/FileContextProjection.ts:29-30,50,86,132-186`；`FileContextCoordinator.ts:229-237,269,318,356-426,551,630-639`；`PrivateFileRecords.ts:1-4`；`tools/recovery/TransientRecoveryProjection.ts:7-8`；`tool-library/builtin/ContextRetrieval.tool.ts:58-70`、`ContextRetrieval.ts:17-18,55`；装配点 `agent/context/ProviderSendRequest.ts:23,102-126,156-160`、`agent/runner/AgentRunner.ts:446`、`agent/LoopRuntime.ts:425` | Project 的「当前源码视图」整条链（约 1,100 行）：`kind:'project-source-window'`、`project:read` 结果形状、`[Current project files]` 头、`contentFormat:'line-numbered'`、续读 `continuation.baseRevisions`、`__project_file_reference__`/`__project_edit_target__` 私有记录、`project:edit/file/change` 恢复投影、`source:`/`view:`/`read-page:` 引用前缀、7 个 `project:*` 工具名决定子 agent 能否读源码 | project 经 `./tool-contract` 的 `fileContextFor`、`FileContext*` 注册来源；Desktop 68 个、Workbench 14 个文件经 `@velaros-ai/project` 在运行时走这条链；agent 自测 5 个 | 整体搬到 `packages/project`。agent 新增两个中立扩展点：`ToolResultBudgetFitter`（`{ id, owns(value), fit(value, maxChars) }`，挂在 `AgentRuntimeCapabilityExtension` 上，接 `Executor.ts:263-270` 的物化、`toolResultSerialization.ts:624-641` 的历史序列化、`history/sanitize.ts:985-989` 的回放三处）与 `ProviderRequestTailContributor`（`seedHistory → prepare → project(history, budget) → finalize`，就是 `ProviderSendRequest.ts:102-160` 现在写死的顺序）；召回域（path/revision/file-snapshot、引用前缀）由 project 贡献；私有记录判断改贡献的谓词；子 agent fork 改钩子。现有 `ToolResultMiddleware` 不够：只在物化前跑一次、没有预算入参、不参与回放与发送尾部 |
| P0-2 | `src/agent/LoopRuntime.ts:88-89,139-157,367-368` | 子 agent 上下文里写死 `system?`、`project?` 两个端口与 `runCommand(command,{background})` 签名（`8d7513e` 刚把 project 也加进来，门禁不禁这两个词所以放行了） | Desktop `src/main/tools/ToolContextTypes.ts:127,157`，Workbench `WorkbenchAgentExecutionStack.ts:631` | 端口自己给子 agent 视图（`forSubAgent()`），或给 `CapabilityDelegationPolicy`（`capabilities/CapabilityExtensions.ts:220-223`）加 `deriveChildContext`；「子 agent 不能起后台进程」语义必须等价保留 |
| P0-3 | `src/agent/CodingSessionTracker.ts:363-518,1270-1272,1379-1388`；`src/coding/paths.ts:2-104`、`edit-results.ts:37-74`、`AutoVerification.ts`；`kernel/final-readiness.ts`、`agent/RunCompletion.ts`；`agent/runner/host-ports.ts:88-101` | 「变更—验证账本」：42 个源码扩展名、27 个构建/锁文件名（package.json、bun.lock、go.mod…）、只认 `system:run`/`project:run` 的命令去重、`office` 特性、revision/snapshot/fileChanges 结果形状、外部触碰冷却 | Desktop 子类化 `CodingSessionTracker`，Workbench 直接 new；**三个仓都没注入 `activityCategories`、`validationInterpreters`、`reminderProducers`**，验证指纹、提醒、修订提示在生产里恒为空，唯一活路径是外部触碰代码文件 → `done.verification={status:'not-run'}` | 中立的「会话工具状态」（类别、租约、审批、运行档、提示词特性、遥测）留下并改名 `SessionToolState`；账本部分（paths、edit-results、AutoVerification、final-readiness 的失败拦截、RunCompletion 摘要、修订/触碰）搬 project，经已有的 `RunnerCodingSessionPolicyBundle`、`CapabilityValidationInterpreter`、`RuntimeReminderProducer` 注入；收尾拦截要新增 `FinishingGateContributor`；没有读者的 API 先删 |
| P0-4 | `src/agent/context/retrieval/References.ts:83-112,157-194,254`、`ReferenceReader.ts:1`（直接 `node:fs` 读盘）、`ContextRetrievalService.ts:888`（`searchTerminalOutput`）、`ContextRetrieval.ts:31-39`、`protocol/types/index.ts:610-646` | Desktop 的命令日志前缀 `vela-command-`/`vela-bg-`/`vela-system-command-`/`vela-system-bg-`、产物目录 `/.velaros/artifacts/`、只认 `logPath` 键、「终端」召回语义 | 生产者全在 Desktop（project/system 的 Runner、`artifact:produce`）；Workbench `WorkbenchContextRecall.ts`；system 验收 `spec/acceptance.test.ts:364-467` | 改成能力贡献的「引用资源解析器/召回域」，读盘跟着贡献方走；`IndexSnapshot.ts:45` 已持久化的 `logReferences` 要兼容读 |
| P0-5 | `src/prompts/catalog.ts:127-173`；`agent/PromptState.ts:112-152,276-285`；`agent/SoloModelRequestOptions.ts:10-31`；`protocol/types/index.ts:104-187,982` | HTML 实时预览与 Widget：写死 skill id `widget-visual-output`/`html-artifact-output`、`<artifact>/<patch>` 流式协议、`artifact:produce`、视觉意图关键词正则、24,000 输出下限；`HtmlArtifactBlock`/`RenderPatch` 与 `packages/html-artifacts/src/protocol.ts:45-80` 重复定义，`ContentBlock` 是封闭联合 | ui 包 6 个文件、Desktop 渲染层 3 个文件 | 提示词做成 html-artifacts 与 Desktop 的 `CapabilityPromptContributor`；意图判断用 `CapabilityIntentClassifier`（先给贡献者快照补上本轮用户文本）；输出下限新增「按特性的请求策略下限」；协议类型从 `@velaros-ai/html-artifacts/protocol` 出，`ContentBlock` 改开放联合 |
| P0-6 | `src/tools/prompt-feature-policy.ts:26,39`（`isOfficeFeature`）、`tools/registry.ts:131,143-165`、`CodingSessionTracker.ts:1270` | `office` 伞特性总开关 | Desktop `PromptFeaturePolicy.ts:31` 实现 | 接口改中立的 `getCoveringFeatures(feature)`，Desktop 实现 |
| P0-7 | `src/protocol/types/index.ts:976-1163,1346-1423`；`src/chat/resolveStoredChatSession.ts` | Desktop 的落盘与 IPC DTO：`StoredChatSession`（folderId、sidebarOrder…）、`ChatFolderRegistry*`（`folders.json`，L1114/1128 把 `engineId` 写死成 `'claude-code'` 或 `'codex'`）、`ChatHook*`、`BackendLogNotification*`、`ChatStreamSnapshot*` | 几乎只有 Desktop（`ChatFolderRegistrySnapshot` 14 个文件、`ChatStreamSnapshot` 15 个） | 挪进 Desktop 的共享协议；engineId 改 `string` |
| P0-8 | `src/agent/retry.ts:27` | `'desktop_offline_seat_occupied'`，Cloud 与 Desktop 都已没有生产者 | 无 | 删 |

**P1/P2：应当改注入**

| # | 位置 | 写死了什么 | 去处 |
| --- | --- | --- | --- |
| P1-1 | `agent/model/PromptCache.ts:21-23,117-183`；`agent/stream/raw-text.ts:14-207`；`stream/recorder.ts:12-17`；`stream/leaked-tool-markup.ts:1-69`；`stream/Consumer.ts:91`；`agent/context/tokenizer.ts`；`agent/retry.ts:18-105` | 厂商知识：anthropic `cacheControl`/openai `promptCacheKey`、Anthropic SSE 与 OpenAI Responses 原始块解析（与 `packages/model/src/ProviderRawStreamText.ts` 近乎逐行重复）、anthropic/vertex/bedrock 缓存 token 路径、DeepSeek DSML 泄漏标记与 `RawReasoningStreamId="deepseek-reasoning"`（已写进持久化历史，改名要兼容读旧值）、o200k 分词器与 `gpt-tokenizer` 依赖、厂商错误码表 | agent 只写 `providerOptions.velaros` 中立标记；`ResolvedAgentModelRuntime`（`agent/model/ModelContracts.ts:26-39`）加可选 `rawChunkText`、错误分类端口；分词改 `TokenCounter` 端口；DSML 过滤由 model 包的 DeepSeek 适配器贡献 |
| P1-2 | `agent/LoopRuntime.ts:163,458-467` | 角色 id `operator`/`coder`/`architect`/`chat`（定义在 Desktop `DesktopAgentRoles.ts`，与 `protocol/types/system.ts:5`「Core 不注册内置角色」自相矛盾） | 角色 provider 给 `expectedOutput` 与默认角色 |
| P1-3 | `agent/AppRuntimeFacts.ts`；`prompts/catalog.ts:51-116` | 运行环境提示段（平台、shell、家目录、「生成命令时以 Shell 为准」），进程级可变单例，只有 Desktop `bootstrap/Services.ts:128` 写 | system 空间的 `CapabilityPromptContributor`；单例删掉 |
| P1-4 | `agent/context/residency/anchors.ts:70-75,116,275`；`residency/skeleton.ts:28-46`；`retrieval/search/Ranking.ts:7-11` | 治理里的编码偏置：23 种扩展名、bun/npm/pnpm/yarn、pytest/jest/vitest/tsc、cargo/go test；骨架栏位写死 files/commands/verification | 给已有的 `ContextRecordClassifier`（`residency/admission.ts:75-81`，Desktop 已注入）加锚点抽取能力，project/system 贡献模式；会影响 B3 重放与驻留判决的确定性 |
| P1-5 | `tools/toolInputHistoryProjection.ts:9,54`；`tools/toolResultSerialization.ts:216,237-250,502-592` | `latexSource`（office）、`widget_code`、`html`、`svg`、`systemToolSuggestion`；旧 `read_file`/`read_files` 结果修补（已无生产者）；`SerializationHints` 认 bash 的 `maxOutputChars` | 改成工具契约上的字段元数据；旧修补删 |
| P1-6 | `tools/ExecutionPolicyFailures.ts:257-268`（`error.context.projectError`）；`tools/recovery/ToolInputReuse.ts:89-94,111-113,356`（`context.project?.getRootPath()`）；`tools/recovery/ExecutionProgress.ts:41-74` | 读 project 的上下文字段 | 中立键；`resourceId` 或 `resolveScope` |
| P2 | `BackgroundJobs.tool.ts:32,49,85`、`AgentWorkflow.tool.ts:25,47`、`Categories.tool.ts:49`、`ToolSpaceSchemas.ts:85`；`bridge/ExternalAgentBridgeLoopbackServer.ts:15-17,94`（`chrome-extension://`）；`session/permissions.ts:18,33,55`（`projectRoot`）；`protocol/types/chatRuntime.ts:25-31,225-229`、`subAgentTask.ts:33-40` | 工具文案点名 `system:list-tasks`、bash、curl；桥写死扩展来源；命令式验证概念 | 文案中立化；来源判断注入；随 P0-3 一起中立化 |

可接受（中立概念碰巧同名或合法身份）：system prompt/`role:'system'`、「系统设置禁用」原因层、`terminal` 作终态、agent 自有的工具命名空间（`context:`、`tooling:`、`plan:`、`goal:`、`directive:`、`job:`、`interaction:`、`agent:`、`skill:`）、`velaros.agent*` 身份、`.velarmod`、`<think>` 内联思考标签、128K/192K/1M 预算档。

**门禁建议**：`scripts/agent/check-arch-boundaries.mjs` 防线⑤的词表补 `project|system:|office|html-artifact|widget|desktop|renderer|anthropic|openai|deepseek|claude|codex|chrome-extension|vela-(command|bg|system)`，用当前违规生成基线后按棘轮归零，`8d7513e` 这类回归就能当场拦下。这件事与五目录改造正交，可以最先做。

### 1.6 其它结构问题（改造时一并处理）

- **导入循环引发的初始化顺序错误（潜在 bug，已复现）**：`bun -e "import('./src/tool-library/index.ts')"` 抛 `Cannot access 'categoriesTools' before initialization`。链路：`tool-library/builtin/ToolSpaceSchemas.ts` → `tools/index.ts` → `tools/Executor.ts` → `kernel/index.ts` → `kernel/background-jobs.ts:31`（`import … from '@velaros-ai/agent'` 自引用根入口）→ `index.ts` → `mods/BuiltinAgentMod.ts:53`。现在不炸只是因为所有消费方都先 import 根入口。第 6 节第 1 步去自引用后自然消失。
- **45 个 `index.ts`**：15 个是 package.json 入口，29 个是没有对应入口的中间转发（barrel），还有 `protocol/types/index.ts` 是 1,432 行的真内容文件（聊天与会话数据模型）；agent 自己的测试经 22 个 barrel 目录取东西（`../src`、`../src/protocol`、`../src/execution`…）。
- **类与接口**：164 个类只有 17 个 `implements`；810 个公开成员要写进类上方接口并逐个写中文说明；939 个私有成员里 139 个不用 `this`（门禁要求搬进 utils）；约 31 个类没有实例状态或只有常量字段（`HistoryMessages`、`TurnHistory`、`ToolResults`、`ChatSearchRanking`、`ChatSearchText`、`ToolArgsSchemaValidator`、三个 `*RunPlanner`…），应改成 utils 函数（公开面在用的留类加带接口实例）；23 个文件一个文件多个类；门禁不许公开静态成员，现有 7 个：`ExecutionEventBus.noop`、`ExecutionSpanLedger.open`、`PromptAuditLedger.open`、`SessionLedger.openHandle`（改成模块级工厂）与 `ContextWorkingSetBudgetGovernor` 的 3 个静态方法（改 utils 函数）。
- **模块级可变状态**：见第 4.2 节。
- **别名**：48 对「新名/旧名」同时出包（`docs/public-api-policy.json` 登记了 9 个弃用别名、22 个支持别名，`execution/index.ts` 一处就有 14 对），1.0 全删。
- **死代码**：`agent/context/StatefulToolResults.ts` 的 `isStatefulToolResultName` 恒返回 false（调用点 `ContextWorkingSetOS.ts:189`、`ToolResultCanonicalizer.ts:55` 的分支死）；`tools/tool-space-resolver.ts:128-131` 的 `PluginBackedToolCategoryIds` 是一个没人往里加的空 `Set` 且整个出包，`isPluginBackedToolCategory` 恒 false（`capability-registry.ts:205`、`tool-space-resolver.ts:380,471` 分支死），`PluginFeatureDescriptions` 恒为 `{}`；`control-plane/SessionToolAllocator.ts` 末尾的单例 `sessionToolAllocator` 带跨会话共享的可变 Map 且没人用；`ContextEpochRequestToolName` 没人用；`kernel/final-readiness.ts:9` 的 `missing-verification` 从不产生；`tools/ExecutionPolicy.ts:803-815` 的计划模式工具门恒放行；`SoloGoalLifecycle.recordSuccessfulCompletion`（:110-120）无调用方；`coding/tool-dedupe.ts:31` 的 `startsWith('tool_')` 分支死。
- **按文字判断失败**：`tools/ExecutionPolicy.ts:769` 用正则 `/not available|不可使用|不可用/` 给失败归类，违反「外面判断失败按错误码」。翻译第 379/433/542 行英文之前必须先改成按错误码，否则改文案会改变归类。
- **常量**：206 个模块级数字常量、55 处数字缺省（`?? 数字`、参数缺省、名字像上限的属性），分布在 97 个文件；包里没有常量表，说明文字里的数字散写（约 60 处，其中「30 分钟」与 `agent/ExecutionLimits.ts:60`、「32 帽」与 `SubAgentDispatcher.ts:274` 形成第二本账；dispatch 的 `attachments` 上限 20、workflow 是 12，两处不一致）。
- **英文文案**：门禁口径（`new XxxError(...)`、`message`/`suggestedNextAction`/`note` 字段）实测 210 处、58 个文件；按「模型看得到的全部字符串」口径约 190 条（第 5.3 节）；另有两个系统性来源：zod 默认报错全英文（全仓无 `z.config` 本地化），系统提示词每段的 `<section name="…">` 用了 17 个英文段名。
- **环境变量**：3 个（`VELAROS_TOKENIZER_ENGINE`、`VELAROS_REMOTE_NODE_URL`、`VELAROS_REMOTE_NODE_PAIRING_CODE`），没有登记表。
- **动态 import 与内联 import 类型**：0，这一条已达标。


## 2. 目标布局

### 2.1 总体

```text
packages/agent/
  MODULE.md                  模块卡片（十节）
  spec/invariants.md         不变量登记
  spec/acceptance.test.ts    验收测试（INV- 编号）
  spec/support.ts            测试共用假对象
  test/                      实现测试（现有 117 个文件保留，import 路径随搬家改写）
  src/
    contract/  provides.ts   requires.ts   constants.ts
    types/     agent.ts（可移植）+ 21 个按域的类型文件
    impl/      AgentTools.ts + 19 个域子目录（158 个类文件 + 8 个错误类）
    utils/     tuning.ts、capabilities.ts + 22 个域子目录（约 270 个文件）
    exports/   index.ts   contracts.ts   chat.ts   tool-contract.ts
    velaros-globals.d.ts     （.d.ts 不在门禁的源文件口径里，照 system 留在 src 根）
```

域名在 impl、utils、types 三处共用，一个域就是一个概念；门禁要求每个子目录至少直接放 3 个源文件，下表每个子目录都满足。

### 2.2 impl/：每个子目录放哪些现有文件

「←」左边是目标文件（文件名即类名），右边是现在的来源。标 ★ 的是新建的类（从闭包工厂、对象字面量、模块级状态或公开的无状态对象改来）。

| 子目录 | 类文件 ← 来源 |
| --- | --- |
| `impl/`（根） | `AgentTools.ts` ← `tool-library/builtin/*.tool.ts` 十个文件的 19 个工具 + `kernel/execution/confirmation-tool.ts`（`interaction:confirm`）+ `mods/BuiltinAgentMod.ts` 的分组与挂载 + `tool-library/builtin/Capabilities.ts` 的能力声明 |
| `builtin/` ★ | 工具 execute 交给的执行类：`ToolSpaceOperations`（tooling:map/read/replace，接 `Categories.ts`、`ToolSpaceQueries.ts`、`ToolSpaceReplace.ts`、`ToolSpaceSkillRead.ts`、`SkillLoadConfirmation.ts` 的编排）、`ContextOperations`（`context:recall` 的 `ContextRetrieval.tool.ts:57-168` 整段下沉，外加 `context:handoff` 的守卫）、`GoalOperations`（`Goals.tool.ts:112-124,197-229,329-415`）、`PlanOperations`（`Plans.tool.ts` 的 21 条语句与 `findPlanArtifact`/`readPlanLifecycle`）、`DirectiveOperations`（`ActiveDirectives.ts` 的读写）、`BackgroundJobOperations`（可用性守卫与输出格式化）；`agent:dispatch` 的字段映射改成 `utils/builtin/dispatch-schemas.ts` 的纯函数，execute 一行 |
| `assembly/` | `AgentExecutionStack` ★ ← `agent/runner/AgentExecutionStack.ts`；`AgentKernelModule` ★ ← `kernel-module.ts`；`AgentModHostAssembler` ★ ← `mods/AgentModHostAssembly.ts`；`ChatKernelSessionBridge` ← `kernel/bridge/`；`KernelSessionController` ← `kernel/controller.ts`；`ToolContractExecutionFacade` ← `node/` |
| `execution/` | `ExecutionService`、`ManagedExecutionRunner`、`SoloExecutionService`、`ExecutionAgentEventFacade`、`ExecutionInteractionFacade`、`ExecutionStateFacade`、`ExecutionTaskFacade` ← `kernel/execution/`；`AgentCapabilityEventPublisher` ← `kernel/`；`KernelSessionRunCoordinator`、`InMemoryKernelSessionInputStore`、`PersistentKernelSessionInputStore` ← `kernel/session-lane.ts`（一个文件拆成三个类文件） |
| `product-session/` | `AgentGoalService` ← `session/goals.ts`；`AgentPlanService` ← `session/plans.ts`；`AgentQuestionService` ← `session/questions.ts` |
| `delegation/` | `SubAgentDispatcher`、`SubAgentProgressDigestRecorder`、`SubAgentProgressLedger` ← `kernel/dispatch/`；`SubAgentDispatchSemaphore` ← `kernel/dispatch/concurrency.ts` 的 `Semaphore`（改名，免得与通用名冲突）；`SubAgentSessionStore` ← `sub-agent/`；`WriteLeaseCoordinator`、`TeamModelRouter` ← `team/` |
| `runner/` | `AgentRunner`、`ModelRuntime`、`AgentWorkflowCoordinator` ← `agent/runner/`；`AgentWorkflowRuntime` ← `workflow/`；`RunContext` ← `agent/run-context/`；`PromptStateBuilder` ← `agent/PromptState.ts`；`ContextBuilder` ← `agent/ContextBuilder.ts`；`PrimaryAgentProfile`、`AgentRoleEngine`、`AgentRolePolicy`、`AgentRoleRegistry` ← `agent/` |
| `loop/` | `SoloStreamLoop` ← `agent/SoloLoop.ts`；`QueryLoop`、`QueryTurn`、`StreamTurn`、`TurnRunner`、`ProviderTurnRequestHelper`、`LoopWindDownGuard`（← `LoopSurface.ts`）、`SoloGoalLifecycle` ← `agent/`；`RetryPolicy` ← `agent/retry.ts`；`AiSdkAgentModelRequestPort` ← `agent/model/AgentModelRequest.ts`；`LinkedAbortScope` ★ ← `agent/model/RequestAbortScope.ts`；`StreamConsumer`（← `Consumer.ts`）、`StreamDiagnosticsHelper`（← `diagnostics.ts`）← `agent/stream/`；`KernelContextEpochGuard` ← `kernel/context-epoch.ts`；`KernelPrefixShapeTracker` ← `kernel/prefix-shape.ts`；`AgentRunPlanLedgerFactory` ← `agent/control-plane/AgentRunPlanLedger.ts` |
| `session/` | `CodingSessionTracker`、`TaskApprovalState`、`SessionTelemetryCounters` ← `agent/`；`CodingSessionEditResultHelper`、`CodingToolCallDeduper`、`CodingSessionVerificationHelper` ← `coding/`；`RuntimeReminderScheduler` ← `reminders/scheduler.ts` |
| `tools/` | `ToolExecutor`（← `Executor.ts`）、`ToolExecutionPolicy`（← `ExecutionPolicy.ts`）、`ToolRegistry`（← `registry.ts`）、`ToolCapabilityRegistry`（← `capability-registry.ts`）、`ExecutionProgress`（← `recovery/`）← `tools/`；`ToolInputReuseStore` ★ ← `tools/recovery/ToolInputReuse.ts` 的模块级 `claims` 锁表；`ProviderToolReferenceCanonicalizer` ★ ← `tools/ToolIdentity.ts` 的闭包工厂；`SessionToolAllocator` ← `agent/control-plane/`；`KernelToolLoopGuard` ← `kernel/tool-loop-guard.ts`；`KernelToolResultMaterializer` ← `kernel/tool-materialization.ts`；`InMemoryKernelToolOutputStore`、`ContextPayloadKernelToolOutputStore` ← `kernel/tool-output-store.ts`；`ToolContractExampleRegistry` ← `tool-contract/examples.ts`；`AgentToolContracts` ★（`./tool-contract` 入口的套件实例，方法转调 utils/toolkit）；`DefaultDenyApprovalPort` ★、`UnattendedSubAgentApprovalPort` ★ ← `tool-contract/approval.ts`；`UnsupportedInteractionPort` ★ ← `tool-contract/interaction.ts`；`ToolExecutionApiBinding` ★ ← `kernel/execution/ToolExecutionApiFactory.ts` |
| `context/` | `ProviderRequestCompiler`（并入 `ProviderSendRequest.ts` 的 `compileProviderSendRequest`）、`ToolResultCanonicalizer`、`UserTextPayloadPlanner`、`InMemoryContextPayloadStore` ← `agent/context/`；`ToolPayloadReferencePlanner` ★ ← `agent/context/ToolPayloadReferencePlanner.ts`（函数里 new canonicalizer，改成持有它的类）；`AgentLoopContextUsageManager` ← `agent/LoopContextUsage.ts`；`ContextUsageCalibrator` ← `agent/`；`FileContextCoordinator` ← `agent/context/resources/`；`FileContextRegistry` ★ ← 同文件的模块级 `WeakMap coordinators` 与 `fileContextFor`（P0-1 搬走后这三个随 project 走） |
| `residency/` | `ContextGovernanceSession`、`ContextGovernanceSessionRegistry`（一个文件拆两个）、`ContextResidencyLedger`（← `ResidencyLedger.ts`）、`ContextDistillRunner`（← `distillRunner.ts`）、`InMemoryContextMigrationEventSink`、`JsonlContextMigrationEventSink`（← `migrationLog.ts`） |
| `retrieval/` | `ChatContextRetrievalService`、`ContextRetrievalIndexBuilder`（← `IndexBuilder.ts`）、`ContextRetrievalPayloadReader`（← `PayloadReader.ts`）、`ContextRetrievalQueryTraceStore`（← `QueryTraceStore.ts`）、`ContextRetrievalBoundedRecentMap`、`ContextRetrievalBoundedCounter`（← `BoundedRecentMap.ts` 拆两个） |
| `guidance/` | `PromptRegistry` ← `prompts/registry.ts`（`createBuiltInPromptRegistry` 作为本文件的工厂）；`AgentSkillRepository`、`FileSkillProvider`、`SkillFileStore`、`SkillMarketClient` ← `skills/` |
| `mods/` | `AgentModLoader`、`AgentModRegistry`、`AgentModSeamDispatcher`（← `AgentModSeams.ts`）、`VelarModArchiveImporter` ← `mods/` |
| `connectors/` | `McpClientConnection` ← `tool-library/mcp/`；`McpToolTranslator` ★（`mcpToolTranslation.ts`、`mcpCallResult.ts` 的公开实例）；`RemoteHostService` ← `remote/`；`RemoteNodeMcpServer` ★ ← `remote/mcp/RemoteNodeMcpBridge.ts`；`RemoteHostToolFactory` ★ ← `remote/remote-tool.ts`（按远端清单生成动态工具）；`ExternalAgentBridgeLoopbackServer`、`ExternalAgentBridgeCommandQueue`、`ExternalAgentBridgeEventWindow`、`ExternalAgentBridgePairingThrottle` ← `bridge/`；`SafeHttpFetch` ★ ← `tool-library/network/FetchSafety.ts` |
| `chat/` | `ChatStreamProtocol`、`ChatStreamConsumer`、`ChatStreamSessionLog` ← `chat/stream/`；`ChatMessages` ← `chat/messages.ts`；`AgentChatKit` ★（`./chat` 入口的渲染侧工具集实例：执行模式解析、上下用量估算、回合上下文格式、目标生命周期投影、会话搜索文本、工具结果展示压缩、内联思考标签切分） |
| `records/` | `ExecutionStore`、`ExecutionRecords`、`ExecutionInteractions`（← `Interactions.ts`）、`ExecutionGuidanceQueue`（← `GuidanceQueue.ts`）、`SourceSessionGuard`、`MonotonicExecutionIdFactory`、`ExecutionAgentEventLedger`（← `agent-events.ts` 的 `ExecAgentEvents`）、`ExecutionPlanLedger`（← `ExecPlanLedger`）、`ExecutionTaskLedger`（← `ExecTaskLedger`）、`ExecutionRouting`（← `ExecRouting`）、`ExecutionWorkflowRoute`（← `ExecWorkflowRoute`）、`SubAgentGuidanceRelayRegistry` ← `execution/`；`ExecutionEventBus` ← `kernel/execution/`；`ProviderTurnEventReducer` ← `kernel/provider-events.ts`；`KernelBackgroundJobManager`、`InMemoryKernelBackgroundJobOutputStore` ← `kernel/background-jobs.ts`；`TurnContextLedger`、`TurnContextAppendHub`、`TurnContextSessionLedgers` ← `agent/run-context/TurnContextLedger.ts` |
| `ledgers/` | `SessionStore`、`SessionLedger`（← `SessionLedger.ts` 拆两个）、`SerialWriteQueue` ← `kernel/session-store/`；`ExecutionSpanLedger`、`ExecutionSpanRecorder`、`OpenExecutionSpan`、`LedgerExecutionSpanScopeFactory`、`LedgerRunSpanScope`、`LedgerTurnSpanScope`、`PromptAuditLedger` ← `kernel/observability/` |
| `errors/` | `KernelContextEpochStaleError`、`KernelSessionRunInterruptedError`、`AgentModStaleSnapshotError`、`AgentSessionLeaseConflictError`、`McpAuthorizationRequiredError`、`ToolInputReuseError`、`WorkflowBudgetExhaustedError`、`WorkflowAbortedError`（8 个，没有方法、不写接口、不出包，外面按 `AgentErrorCodes` 判断） |

类名统一：`Exec*` 短名改回完整名（`ExecStore` → `ExecutionStore` 等），文件名跟完整名；`Kernel*` 前缀在 agent 里指的是 Agent 自己的会话控制面，与 `@velaros-ai/kernel` 同名异义，建议第 8 步可选改名（`KernelBackgroundJobManager` → `BackgroundJobManager`、`KernelToolLoopGuard` → `ToolLoopGuard`…），第一轮先不动，免得和搬家混在一起。

### 2.3 分层（从上到下；上层可以引下层与同层）

| 层 | 登记（`governed-modules.mjs` 的 `layers`） | 说明 |
| --- | --- | --- |
| 1 工具 | `AgentTools.ts` | 20 个工具的定义、分组、内置 mod |
| 2 工具执行 | `builtin/` | 各组工具的 execute 交给的类，只经工具上下文调宿主 |
| 3 装配 | `assembly/` | 执行栈、Kernel 模块、mod 宿主组装、会话通道、控制器、Node 工具契约门面 |
| 4 执行服务 | `execution/`、`product-session/` | 一次 run 的所有权与生命周期、会话输入准入与运行权；产品 Session 应用服务 |
| 5 委派 | `delegation/` | 子 agent 派发、线程存储、团队路由与写租约 |
| 6 运行 | `runner/` | Runner、模型运行时、提示词组装、角色、工作流解释器 |
| 7 回合 | `loop/` | 主会话/子 agent 循环、回合、请求组装、流消费、重试、纪元与前缀守卫 |
| 8 会话态与工具链 | `session/`、`tools/` | 会话工作态、审批、提醒；工具执行、策略、注册表、输出句柄化、工具契约套件 |
| 9 上下文 | `context/`、`residency/`、`retrieval/` | 请求编译、驻留账本与治理、召回 |
| 10 基础能力 | `guidance/`、`mods/`、`connectors/`、`chat/` | 提示词段与技能、mod 注册机、MCP/远程/外部桥/安全取网、渲染侧聊天流 |
| 11 执行记录 | `records/` | 执行记录、账本、事件总线、回合事件归约、后台任务、回合上下文账本（被多层引用，所以放低） |
| 12 落盘账本 | `ledgers/` | 会话树账本、span 账本、提示词审计 |
| 13 错误类 | `errors/` | |

**实测**：把 134 个有状态类按上表归位后（新建的 ★ 类只依赖 utils，不影响结论），逐条检查类到类的引用（值与类型都算），只要做下面 4 处调整，**下层引上层 0 处**：

1. `ExecutionEventBus` 从 `kernel/execution/` 放到 `records/`：`SubAgentDispatcher`、`AgentWorkflowCoordinator`、`AgentRunner`、`ModelRuntime` 与四个类型文件都引它；
2. `AgentWorkflowCoordinator` 与 `AgentWorkflowRuntime` 放在 `runner/`（`AgentRunner` 直接 new 前者）；
3. `ProviderTurnEventReducer` 放到 `records/`（`ToolExecutor` 与 `StreamConsumer` 都引它）；
4. `KernelBackgroundJobManager`、`TurnContextLedger` 三件套、`SubAgentGuidanceRelayRegistry` 放到 `records/`（`ExecutionService` new 后者，`SubAgentDispatcher` 引前者，后台任务又引回合上下文账本；不放低就会出现 execution ↔ delegation 互引）。

utils 在所有层之下，谁都能用；它只引 utils、types 与合同。

### 2.4 utils/：子目录与来源

下表是建议的最终文件名。附录 A 里的 utils 文件名是按原文件名机械换成 kebab-case 的缺省名；第 2 步整文件搬家按缺省名走，第 3 步拆分时再按本表合并、改名，两处不一致时以本表为准。

| 子目录 | 文件 ← 来源（纯函数、规则名单、schema；类里不用 this 的私有方法也并进对应文件） |
| --- | --- |
| `utils/`（根） | `tuning.ts` ★（全包可调参数表 `AgentTuning`，约 150 项，按 loop/context/residency/retrieval/tools/execution/delegation/connectors 分组）；`capabilities.ts` ← `capabilities/CapabilityExtensions.ts` 的 17 个 `resolve*` 函数 |
| `loop/` | `agent-loop.ts`、`loop-runtime.ts`、`loop-surface.ts`、`context-degrade-ladder.ts`、`context-phase.ts`、`execution-limits.ts`、`intent-signals.ts`、`run-completion.ts`、`tool-space-bootstrap-planner.ts`、`turn-capability-snapshot.ts`、`provider-turn-request.ts`、`solo-*.ts`（12 个 Solo 文件：finishing-gate、background-completion-gate、context-degrade-action、loop-telemetry、loop-tool-exposure、model-request-options、process-update-cadence、run-plan-preparer、runtime-guidance、tool-space-bootstrap-fallback、tool-use-continuation、turn-wind-down）、`run-planner.ts`、`capability-run-planner.ts`、`runtime-run-planner.ts` ← `agent/control-plane/` 的无状态类、`context-epoch.ts`、`prefix-shape.ts`、`final-readiness.ts` ← `kernel/` |
| `stream/` | `tool-input.ts`、`inline-reasoning-tags.ts`、`leaked-tool-markup.ts`、`raw-text.ts`、`recorder.ts`、`idle-read.ts`、`generated-artifacts.ts`、`empty-stream-recovery.ts`、`output-truncation-recovery.ts`、`tool-call-id.ts` ← `agent/stream/` |
| `model/` | `prompt-cache.ts`、`model-request-error.ts`、`model-input-compatibility.ts` ← `agent/model/`；`retry.ts` ← `agent/retry.ts` 的 12 个无 this 私有方法与 `isContextOverflowError` 等 |
| `history/` | `sanitize.ts`（1,230 行，不拆）、`validate.ts`、`repair.ts`、`request.ts`、`messages.ts`（← `HistoryMessages` 无状态类）、`turn.ts`（← `ToolResults`、`TurnHistory` 无状态类）、`internal-messages.ts`、`context-os-message.ts` ← `agent/history/` |
| `context/` | `context-ledger.ts`、`context-budget.ts`、`context-usage.ts`、`context-ref-envelope.ts`、`working-set.ts`（← `ContextWorkingSetOS` 无状态类）、`working-set-budget.ts`（← `ContextWorkingSetBudgetGovernor` 只有静态方法）、`working-set-zones.ts`、`provider-request.ts`、`provider-request-snapshot.ts`、`tokenizer.ts`、`user-message-text.ts` ← `agent/context/`；`content-hash.ts`、`floor.ts`、`message-scan.ts`、`pipeline.ts`、`serialization.ts`、`budget-stage.ts`、`history-sanitize-stage.ts`、`retained-context-stage.ts` ← `providerRequest/`；`file-context-projection.ts`、`file-snapshot-archive.ts` ← `resources/`（P0-1 后随 project 走） |
| `residency/` | `admission.ts`、`anchors.ts`、`dashboard.ts`、`determinism.ts`、`distill.ts`、`governance-epoch.ts`、`governance-config.ts`、`governance-window.ts`、`ingest.ts`、`message-facts.ts`、`migration-log.ts`（格式化函数）、`projection.ts`、`session-key.ts`、`skeleton.ts`、`context-record.ts` ← `agent/context/residency/` |
| `retrieval/` | `index-snapshot.ts`、`pagination.ts`、`payload-reader.ts`（`selectJsonPath`）、`references.ts`（← 常量字段单例类）、`reference-reader.ts`（← 常量字段类，含 `node:fs`）、`search-messages.ts`、`search-ranking.ts`、`search-text.ts`（← `search/` 三个常量字段单例类）← `agent/context/retrieval/` |
| `runner/` | `run-profile.ts`、`runtime-profiles.ts`、`role-router.ts`、`prompt-state.ts`、`context-builder.ts`（← `ContextBuilderParts` 无状态类）、`runtime-events.ts`、`runtime-input.ts`、`turn-context-format.ts`、`turn-payload.ts`（← `TurnPayload` 无状态类）、`goal-lifecycle-projection.ts`、`goal-lifecycle.ts`、`approval-registry-key.ts`（← `runner/codingTracking.ts`）、`execution-modes.ts` ← `execution-modes/` |
| `session/` | `auto-verification.ts`、`paths.ts`（P0-3 后随 project 走）、`tool-dedupe.ts` ← `coding/`；`coding-session.ts`（`CodingSessionTracker` 不用 this 的私有方法） |
| `tools/` | `execution-policy-failures.ts`、`tool-identity.ts`、`access-decision.ts`、`access-policy.ts`、`discovery-availability.ts`、`history-preview-placeholder.ts`、`model-input-policy.ts`、`model-image-lift.ts`、`prompt-feature-policy.ts`、`tool-space-recovery.ts`、`tool-space-resolver.ts`、`tool-input-history-projection.ts`、`tool-input-recall.ts`、`tool-result-serialization.ts`、`tool-args-validator.ts`（← 常量字段单例类 `ToolArgsSchemaValidator`）、`tool-input-reuse.ts`、`transient-recovery-projection.ts`（P0-1 后随 project 走）、`executor.ts`、`tool-loop-guard.ts`、`tool-output-store.ts` ← `tools/`、`kernel/` |
| `toolkit/` | `define.ts`、`tool-description.ts`、`tool-input-bounds.ts`、`forgiving-schema.ts`、`schema-bundle.ts`、`approval.ts`、`task-approval.ts`、`concepts.ts`、`discovery.ts`、`examples.ts`、`identity.ts` ← `tool-contract/` |
| `builtin/` | `define-agent-tool.ts`（← `tool-library/defineVelaTool.ts`，登记为 toolDefiner 的 `defineVelaTool` 声明在这里，同 system 的 `utils/tool.ts`）、`tool-space-schemas.ts`、`tool-space-activation.ts`、`tool-space-queries.ts`、`tool-space-search.ts`、`tool-search-terms.ts`、`tool-read-details.ts`、`step-refs.ts`、`goals.ts`、`plans.ts`、`active-directives.ts`、`background-jobs.ts`、`context-recall.ts`、`dispatch-schemas.ts`（← `DispatchAgent.ts`）、`workflow-schemas.ts`（← `AgentWorkflow.ts`）← `tool-library/builtin/` |
| `records/` | `store.ts`、`records.ts`、`plan-state.ts`、`state-machine.ts`、`task-ledger.ts`、`routing.ts`、`agent-events.ts`、`guidance-relay.ts`（← `GuidanceRelayPlanner.ts`）、`background-jobs.ts`、`provider-events.ts`、`turn-context-ledger.ts` ← `execution/`、`kernel/` |
| `execution/` | `session-lane.ts`、`session-policy.ts`（← `kernel/policy.ts` 无状态类）、`managed-execution.ts`、`solo-execution.ts` ← `kernel/` |
| `delegation/` | `instruction.ts`、`result-format.ts`、`dispatcher.ts`（`SubAgentDispatcher` 的 14 个无 this 私有方法）← `kernel/dispatch/`；`structured-output.ts`、`readonly-policy.ts`、`result-builder.ts`、`type-registry.ts` ← `sub-agent/` |
| `ledgers/` | `jsonl-file.ts`、`ledger-file.ts`、`session-tree.ts`、`execution-ledger-file.ts`、`execution-span-tree.ts`、`execution-span-debug.ts`、`prompt-audit.ts` ← `kernel/` |
| `guidance/` | `catalog.ts`、`segments-runtime.ts`、`segments-shared.ts`、`segments-task.ts` ← `prompts/`；`skill-definition.ts`、`skill-frontmatter.ts` ← `skills/` |
| `mods/` | `projection.ts`、`seams.ts`、`loader.ts`、`archive.ts` ← `mods/` |
| `connectors/` | `mcp-tool-translation.ts`、`mcp-call-result.ts`、`mcp-approval-arguments.ts` ← `tool-library/mcp/`；`fetch-safety.ts` ← `network/`；`remote-tool.ts`、`remote-node-mcp.ts`、`stdio-entry.ts` ← `remote/`；`bridge-state.ts` ← `bridge/` |
| `chat/` | `messages.ts`、`send-request.ts`、`stored-session.ts`（P0-7 后随 Desktop 走）、`session-lineage.ts`、`session-search-text.ts` ← `chat/` |
| `product-session/` | `archive.ts`、`lifecycle.ts`、`permissions.ts`、`plans.ts`、`goals.ts`、`questions.ts` ← `session/` |
| `wire/` | 全部 zod schema 与解析函数 ← `protocol/`：`agent-capability.ts`、`execution.ts`、`external-agent-bridge.ts`、`lease.ts`、`message.ts`、`mods.ts`、`observability.ts`、`session.ts`、`product-surface.ts`、`prompt-features.ts`、`steps.ts`、`typed-field-asserts.ts`、`conversation-kind.ts`（← `protocol/types/index.ts` 的 4 个判定函数）、`storage.ts`；外加 `session/contracts.ts` 的两个 schema |

### 2.5 types/：按域分文件

| 文件 | 来源 |
| --- | --- |
| `types/agent.ts`（**可移植**，`./contracts` 入口；不 import、不带函数成员） | `protocol/types/` 13 个文件里的数据类型（聊天与会话数据模型、流事件、执行记录、工具描述与权限、类别、能力声明、子 agent 任务、团队、回合上下文、技能描述）+ `protocol/*.ts` 里 70 个由 `z.infer` 推导的类型改成手写（会话树 entry、mod 清单、span、租约、执行动词、外部桥消息、转录）；`@velaros-ai/core/error` 的 `SerializedError`、`ErrorCode` 在这里放同名同形的本地副本（同 system 的 `SystemShellKind` 先例） |
| `types/tool-context.ts` | `tool-library/KernelToolContext.ts` 与 `tool-library/context/*.ts` 里 loop 自己维护、不属于宿主的成员（可见工具名、传输名、签名、surface profile 的读写） |
| `types/loop.ts`、`types/runner.ts`、`types/session.ts`、`types/tools.ts`、`types/toolkit.ts`、`types/builtin.ts`、`types/context.ts`、`types/residency.ts`、`types/retrieval.ts`、`types/history.ts`、`types/records.ts`、`types/execution.ts`、`types/delegation.ts`、`types/ledgers.ts`、`types/guidance.ts`、`types/mods.ts`、`types/connectors.ts`、`types/chat.ts`、`types/product-session.ts`、`types/capabilities.ts` | 各域现有文件里的类型声明（附录 A 每行写了去处）；utils 需要类时收的最小形状也放在这里（`ResidencyLedgerView`、`GovernanceSessionLookup`、`ProviderTurnRecorder`、`McpToolCaller`、`ToolExampleSource`） |

### 2.6 exports/：四个入口

| 入口 | 文件 | 给谁 | 内容 |
| --- | --- | --- | --- |
| `.` | `exports/index.ts` | Node 宿主 | provides 登记的接口与它们的实例/工厂、requires 的全部接口、公开签名用到的 types；`export * from './contracts.js'` |
| `./contracts` | `exports/contracts.ts` | 任何进程，含渲染进程 | `export * from '../contract/constants.js'`、`export type * from '../types/agent.js'` |
| `./chat` | `exports/chat.ts` | 渲染进程 | `chatStreamProtocol`、`createChatStreamConsumer`、`createChatStreamSessionLog`、`chatMessages`、`agentChat`、`agentWire` 与它们的接口 |
| `./tool-contract` | `exports/tool-contract.ts` | 六个空间包与宿主写工具 | `agentToolContracts`、`defaultDenyApprovalPort`、`defaultUnsupportedInteractionPort`、`fileContextRegistry`、`toolContractExamples` 与工具规格、审批、文件上下文类型 |

`browserSafeEntries` 登记 `contracts.ts`、`chat.ts`、`tool-contract.ts`；门禁的 Node 内置模块检查取代 `scripts/agent/check-browser-surface.mjs` 的 vite 打包检查（后者可保留作双保险，但路径要改）。门禁把入口名映射成 `exports/<名>.ts`，名字里不能带 `/`，所以 `./remote/mcp`、`./protocol/*` 这类子路径不能原样保留。

## 3. 合同设计草案

原则（照 ADR 0003/0007 与 system 先例）：宿主拿到的是**整件能力**，不是零件。类实现的 API 写在类上方、`provides.ts` 用 `export type { XxxApi } from '../impl/<域>/<类>.js'` 登记；没有类的公开接口直接声明在 `provides.ts`；出包的值只能是常量表，或 impl 里标注成公开接口类型的实例与工厂。

判定口径：**有外部消费方的类才进产品面**；只被 Desktop 一处拿来自己拼装、而执行栈已经能给的，不进产品面，宿主改用执行栈（和 system 让 Desktop 改用 `createLocalSystemKernel` 同理）。下面每一行都写了证据（消费方文件数）。

### 3.1 `contract/provides.ts`：产品面

**A. 执行与会话（宿主装配的主干）**

| 公开接口 | 实现（impl） | 出包的值 | 成员 | 谁在用 / 说明 |
| --- | --- | --- | ---: | --- |
| `AgentExecutionStackApi`、`AgentExecutionStackWithQueryApi` | `assembly/AgentExecutionStack` | 工厂 `createAgentExecutionStack(options): AgentExecutionStackApi` | 4 / 6 | Desktop 1、Workbench 1、Termel 1；成为宿主的首选入口，`resolveAgentExecutionLimits`、`createBuiltInPromptRegistry`、治理登记处都从它的选项进 |
| `AgentRunnerApi` | `runner/AgentRunner` | 经 `AgentExecutionStackWithQueryApi.createRunner` 取得 | 6 | Desktop 1 |
| `ExecutionServiceApi` | `execution/ExecutionService` | 工厂 `createExecutionService` | 33 | Desktop 5；33 个方法里约三分之一只被 `SoloExecutionService`、工具执行 API 绑定内部用，登记前按消费方收窄 |
| `SoloExecutionServiceApi` | `execution/SoloExecutionService` | 工厂 `createSoloExecutionService` | 1 | Desktop 8 |
| `ExecutionEventBusApi` | `records/ExecutionEventBus` | 工厂 `createExecutionEventBus` | 18 | Desktop 8、Workbench 16、Termel 1；公开静态成员 `ExecutionEventBus.noop()` 改成工厂 `createNoopExecutionEventBus()` |
| `ChatKernelSessionBridgeApi`、`KernelSessionControllerApi` | `assembly/ChatKernelSessionBridge`、`assembly/KernelSessionController` | 工厂 `createChatKernelSessionBridge` | 8 / 7 | Desktop 3 |
| `BackgroundJobManagerApi` | `records/KernelBackgroundJobManager` | 工厂 `createBackgroundJobManager` | 19 | Desktop 5、Workbench 1 |
| `SubAgentDispatcherApi` | `delegation/SubAgentDispatcher` | 工厂 `createSubAgentDispatcher` | 8 | Desktop 3、Workbench 1 |
| `SubAgentSessionStoreApi`、`TeamModelRouterApi`、`WriteLeaseCoordinatorApi`、`SubAgentGuidanceRelayRegistryApi`、`ExecutionGuidanceQueueApi` | `delegation/*`、`records/*` | 各一个工厂 | 13/5/2/7/7 | Termel 1；Desktop 1–2、Workbench 1 |
| `AgentCapabilityService`（直接声明）、`AgentCapabilityEventPublisherApi` | `assembly/AgentKernelModule`、`execution/AgentCapabilityEventPublisher` | 工厂 `createAgentKernelModule(options): KernelModuleDefinition`；令牌 `AgentCapability`（文件末尾带类型实例） | — | Desktop 2、Workbench 2 |

**B. 会话里的状态与策略件（宿主每会话 new 一份）**

| 公开接口 | 实现 | 出包的值 | 成员 | 说明 |
| --- | --- | --- | ---: | --- |
| `CodingSessionTrackerApi` | `session/CodingSessionTracker` | 工厂 `createCodingSessionTracker` | 71 | Desktop 1（子类化，迁移时改组合）、Workbench 4、Termel 1；P0-3 拆完后改名 `SessionToolStateApi`，成员降到约 45 |
| `PrimaryAgentProfileApi`、`AgentRoleEngineApi` | `runner/*` | 工厂 | 1 / 1 | Desktop 4+1、Workbench 3、Termel 1 |
| `PromptRegistryApi` | `guidance/PromptRegistry` | 工厂 `createBuiltInPromptRegistry`、`createPromptRegistry` | 7 | Desktop 2、Workbench 1、Termel 1；段的构造（`createTextPromptSegment`、`createSelectedSkillPromptSegment`、`PromptSegmentPriority`）作为本接口的方法与常量 |
| `RetryPolicyApi` | `loop/RetryPolicy` | 实例 `agentRetryPolicy` | 6 | Desktop 1；也可并进执行栈选项 |

**C. 上下文**

| 公开接口 | 实现 | 出包的值 | 成员 | 说明 |
| --- | --- | --- | ---: | --- |
| `ContextGovernanceRegistryApi` | `residency/ContextGovernanceSessionRegistry` | 工厂 | 10 | Desktop 8、Workbench 3、project 测试 4 |
| `ContextRetrievalServiceApi` | `retrieval/ChatContextRetrievalService` | 工厂 | 7 | Desktop 6、Workbench 1；Desktop 用的 `chatSearchRanking`、`chatSearchMessages`、`contextRetrievalFingerprintsEqual` 作为本接口的方法 |
| `ProviderRequestCompilerApi` | `context/ProviderRequestCompiler`（含 `compileSendRequest`） | 工厂 | 4 | project 的 4 个集成测试；它们挪到仓库层 `tests/` 后经本接口取 |
| `ContextPayloadStore`（在 requires，宿主可换持久实现） | `context/InMemoryContextPayloadStore` | 工厂 `createInMemoryContextPayloadStore(): ContextPayloadStore` | 9 | Workbench 2、project 测试 9 |
| `TurnContextSessionLedgersApi`、`TurnContextAppendBus` | `records/TurnContextSessionLedgers`、`records/TurnContextAppendHub` | 工厂各一 | 4 / 2 | browser 2、memory 1、Desktop 6 |

**D. 工具**

| 公开接口 | 实现 | 出包的值 | 说明 |
| --- | --- | --- | --- |
| `VelaTool`、`AgentToolCollection`（直接声明，同 system 的 `VelaTool`/`SystemToolCollection`） | `impl/AgentTools.ts` | 实例 `agentTools`（20 个工具按名索引）、`agentToolCategories` | 取代 `activeDirectiveTools`、`agentWorkflowTools`、`backgroundJobTools`、`categoriesTools`、`contextRetrievalTools`、`dispatchAgentTools`、`goalTools`、`plansTools`、`contextDistillTools`、`contextHandoffTools`、`confirmationTools` 十一个集合（Desktop/Workbench 各自挑着挂，正是 `context:handoff` 漏挂的原因） |
| `BuiltinAgentModDefinition`（直接声明） | `impl/AgentTools.ts` | 工厂 `createBuiltinAgentModDefinition` | 取代 `createBuiltinAgentModPackage`、`collectBuiltinAgentModTools`、`BuiltinAgentModToolCollections` |
| `ToolRegistryApi`、`ToolCapabilityRegistryApi` | `tools/*` | 工厂 | Desktop 各 1 |
| `ToolContractExecutionFacadeApi` | `assembly/ToolContractExecutionFacade` | 工厂 | Desktop 1（原 `./node` 入口）；也作为 project 集成测试执行单次工具调用的正门，取代直接 new `ToolExecutor`/`ToolExecutionPolicy` |
| `ToolTransportNamesApi` | `tools/ProviderToolReferenceCanonicalizer` 等 | 实例 `toolTransportNames` | Desktop 2、Workbench 1：`createToolTransportNamePlan`、`createToolTransportProjection`、`rewriteCanonicalToolReferences` 变成方法；`ProviderToolNamePattern` 以字符串进常量表 |

**E. 工具契约套件（`./tool-contract` 入口）**

| 公开接口 | 实现 | 出包的值 | 方法（← 现有函数） |
| --- | --- | --- | --- |
| `AgentToolContractsApi` | `tools/AgentToolContracts` | 实例 `agentToolContracts` | `define` ← `defineToolRuntimeSpec`；`renderParameterDescription`；`structureDescriptionsForCategory` ← `structureToolDescriptionsForCategory`；`compactDescription` ← `compactStructuredToolDescription`；`isStructuredDescription`；`createSchemaBundle`；`schemaToInputSchema`；`canonicalizeProviderInputSchema`；`isCanonicalToolId`/`assertCanonicalToolId`；`inputBounds` ← `optionalReadStartLine`/`EndLine`/`MaxChars`、`refineBoundedReadInput`、`requiredResultLimit`、`applyDefaultRecursiveMaxDepth`；`withInputReuse`/`resolveInputReuse`；`createApprovalOperationKey`；`createManualApprovalOptions`；`createTaskApprovalPort`；`readSchemaDiscoveryNames` |
| `ApprovalPort`、`InteractionPort`（接口在 requires） | `tools/DefaultDenyApprovalPort`、`tools/UnsupportedInteractionPort` | 实例 `defaultDenyApprovalPort`、`defaultUnsupportedInteractionPort` | project 5、Desktop/Workbench/Termel 各 1–2 |
| `FileContextRegistryApi` | `context/FileContextRegistry` | 实例 `fileContextRegistry` | `for(carrier)` ← `fileContextFor`（project 5、Workbench 2）；P0-1 搬走后改由 project 自己持有 |
| `ToolContractExampleRegistryApi` | `tools/ToolContractExampleRegistry` | 实例 `toolContractExamples` | ← `DefaultToolContractExampleRegistry`（project 2）；同时去掉 `define` 顺手写全局表的副作用 |

**F. mod、技能、连接、账本**

| 公开接口 | 实现 | 出包的值 | 谁在用 |
| --- | --- | --- | --- |
| `AgentModLoaderApi`、`AgentModSeamDispatcherApi`、`AgentModHostAssemblerApi`、`VelarModArchiveImporterApi` | `mods/*`、`assembly/AgentModHostAssembler` | 工厂各一；`AgentModHostAssemblerApi` 收 `assembleAgentMods`、`discoverAgentModPackages`、`createAgentModSurfaceSnapshot` | Desktop 1–3、Workbench 1、Termel 1 |
| `AgentSkillRepositoryApi`、`FileSkillProviderApi`、`SkillFileStoreApi`、`SkillMarketClientApi` | `guidance/*` | 工厂各一；`SkillFileStoreApi` 带 `parseFrontmatter`、`parseFrontmatterList`、`formatDisplayMarkdown`；`createSkillDefinition` 并进 `AgentSkillRepositoryApi` | Desktop 2–7、Termel 1–2 |
| `McpClientConnectionApi`、`McpToolTranslatorApi` | `connectors/McpClientConnection`、`connectors/McpToolTranslator` | 工厂 `createMcpClientConnection`；实例 `mcpToolTranslator`（`translateTool`、`convertInputSchema`、`buildToolName`、`translateCallResult`） | Desktop 4、Termel 1 |
| `RemoteHostServiceApi`、`RemoteNodeMcpServerApi` | `connectors/*` | 工厂各一；`runRemoteNodeMcpStdio` 作为工厂式入口 | Termel 1 |
| `ExternalAgentBridgeLoopbackServerApi`、`ExternalAgentBridgeCommandQueueApi`、`ExternalAgentBridgeEventWindowApi`、`ExternalAgentBridgePairingThrottleApi` | `connectors/*` | 工厂各一；`externalAgentBridgeTokensEqual` 并进节流接口 | Desktop 1、Termel 1 |
| `SafeHttpFetchApi` | `connectors/SafeHttpFetch` | 实例 `safeHttpFetch`（`fetch`、`assertUrl`） | Desktop 2 |
| `SessionStoreApi`、`SessionLedgerApi`、`ExecutionSpanScopeFactoryApi`、`AgentLedgerFilesApi` | `ledgers/*` | 工厂 `createSessionStore`、`createLedgerExecutionSpanScopeFactory`；实例 `agentLedgerFiles`（`readLedgerFile`、`truncateLedgerToEntryCount`、`canonicalJsonStringify`、`completeLineByteLength`、`readSpanLedgerFile`、`readPromptAuditFile`、`projectExecutionSpanDebug`、`isSnapshotComparableEntry`） | Desktop 1–5 |
| `AgentGoalServiceApi`、`AgentPlanServiceApi`、`AgentQuestionServiceApi`、`AgentSessionKitApi` | `product-session/*` | 工厂各一；实例 `agentSessionKit`（归档信封 create/parse、租约判定、权限规则评估） | Termel 6 |
| `GuidanceRelayKitApi` | `records/` 下的小类 | 实例 `guidanceRelay`（`buildPrompt`、`parsePlan`、`normalizePlan`、`resolveMainAgentMessage`） | Desktop 1（它实现 `ExecutionGuidanceRelayPlanner` 端口时用） |
| `AgentWireApi` | `chat/` 下的小类（浏览器安全） | 实例 `agentWire`：`parseModManifest`、`parseCapabilityExecuteEnvelope`、`createCapabilityExecutionEventEnvelope`、`parseExternalBridgeClientMessage`、`normalizePromptFeatures`、`assertReasoningLevel`、`resolveThinkingDepth`、`reasoningLevelToThinkingDepth`、`resolveRunProfileSelectionId`、`branchTimelineKey`、`mergeSurfaceSkillSelection`、`serializeSurfaceContextSnapshot`、`parseToolCatalogSnapshot` | Desktop 约 30 处、Workbench 3、Termel 2（protocol 172 个值里真被用的 33 个，除常量外都收进这里） |

**G. 渲染侧（`./chat` 入口）**

| 公开接口 | 实现 | 出包的值 | 谁在用 |
| --- | --- | --- | --- |
| `ChatStreamProtocolApi` | `chat/ChatStreamProtocol` | 实例 `chatStreamProtocol` | Desktop 8 |
| `ChatStreamConsumerApi`、`ChatStreamSessionLogApi` | `chat/*` | 工厂各一 | Desktop 4 |
| `ChatMessagesApi` | `chat/ChatMessages` | 实例 `chatMessages`（含 `resolveConversationKind`、`isConversationTurnInput`、`isSystemNotice`） | Desktop 3+15、Workbench 1+3 |
| `AgentChatKitApi` | `chat/AgentChatKit` | 实例 `agentChat`：`normalizeExecutionModes`、`resolveExecutionModes`、`isExecutionModeActive`、`listExecutionModes`；`estimateContextUsage`；`renderTurnContextBlock`、`formatTurnContextOmittedNote`；`findCurrentGoal`、`goalLifecycleToUpsertInput`、`getGoalLifecycleStatus`；`normalizeSessionSearchText`、`extractSessionSearchTerms`；`resolveChatSendRequestOptions`；`compactToolResultForDisplay`、`compactToolInputForModel`、`serializeToolResultForRecall`；内联思考标签 `split`/`flush`；`readGeneratedFilePayload`、`readSourcePayload` | Desktop 约 40 处、Workbench 5 |

合计：约 60 个公开接口（其中直接声明 4 个，其余是登记的类上方接口），对外的值约 55 个（实例 15、工厂 40）。system 是 12 个接口、16 个值，agent 的量级高是职能多，但比现在根入口的 754 个值少一个数量级。

### 3.2 `contract/requires.ts`：注入面

每个注入点写清谁给、什么时候给、必不必须（下表是草案，接口名沿用现有名，括号里是现在的位置）。

| 注入点 | 谁给、何时 | 必须 |
| --- | --- | --- |
| `AgentModelResolverPort`、`AgentModelProvider`、`AgentModelRequestOptions`、`AgentModelRequestPolicy`（`agent/model/ModelContracts.ts`）；可选新增 `rawChunkText`、错误分类、`TokenCounter`（P1-1） | 宿主，建执行栈时 | 必须 |
| `AgentExecutionStackToolRegistry`（`agent/runner/AgentExecutionStack.ts`，= Solo/Query/TurnRunner 三个注册表端口的交集）、`AgentTurnCapabilitySnapshotSource`（`agent/TurnCapabilitySnapshot.ts`） | 宿主，建执行栈时；每回合开头捕获一次快照 | 必须 |
| `AgentToolContext`（原 `KernelToolContext` 的宿主部分，约 22 个工具真会调的成员）及 `ToolActiveContextApi`、`ToolConversationContextApi`、`ToolRoleApi`、`ToolRuntimeApi`、`ToolSkillsApi`（`tool-library/context/*`） | 宿主，每次调工具时（经 `RunnerToolContextBuilder`） | 必须 |
| `ApprovalPort`（`tool-contract/approval.ts`）、`InteractionPort`（`tool-contract/interaction.ts`） | 宿主，每次调工具时；无人值守宿主给默认拒绝端口 | 必须 |
| `AgentRuntimeCapabilityPorts` 及其成员接口 `ToolResultMiddleware`、`ToolValidationHintProvider`、`ToolAllocationMetadata`、`CapabilityPromptContributor`、`CapabilityContextCollector`、`CapabilityIntentClassifier`、`CapabilityValidationInterpreter`、`CapabilityScopePolicy`、`CapabilityDelegationPolicy`（`capabilities/CapabilityExtensions.ts`）；P0 新增 `ToolResultBudgetFitter`、`ProviderRequestTailContributor`、`FinishingGateContributor`、`deriveChildContext` | 空间包经 mod 或宿主装配根贡献 | 可选（端口缺席 = 行为缺席） |
| `RunnerToolContextBuilder`、`RunnerExecutionEnvironmentPort`、`RunnerConfigService`、`RunnerSubAgentDispatcher`、`RunnerModelRuntimePort`（`agent/runner/host-ports.ts`） | 宿主，建 Runner 时 | 前三个必须 |
| `AgentSurfaceProfileProvider`（`agent/runner/AgentSurfaceProfile.ts`）、`AgentRoleDescriptorProvider`（`agent/RoleRegistry.ts`）、`AgentSkillProvider`（`skills/AgentSkillProvider.ts`）、`SubAgentTypeProvider`（`sub-agent/SubAgentTypeRegistry.ts`）、`RuntimePromptFeaturePolicy`（`tools/prompt-feature-policy.ts`） | 宿主或 mod，建执行栈时 | 可选，有默认 |
| `AgentRunLifecycle`、`AgentModelRetryPolicy`（`agent/RunLifecycle.ts`）、`AgentRuntimeInputPort`（`agent/RuntimeInputPort.ts`）、`AgentExecutionConfig`/`AgentChatRuntimeConfig`/`AgentSystemRuntimeConfig`（`agent/RuntimeConfiguration.ts`） | 宿主，每次 run | 必须 / 可选 |
| `AuthGatePort`、`ExecutionRecordsPathPort`、`ExecutionResourcePort`、`ExecutionActivitySignalsPort`、`ExecutionCollaborationPort`、`ExecutionGuidanceRelayPlanner`（`kernel/execution/host-ports.ts`）；`ExecutionIdFactory`、`ExecutionClock`（`execution/ExecutionIdFactory.ts`） | 宿主，建执行服务时 | 前三个必须 |
| `SubAgentConfigPort`、`SubAgentQueryRunner`、`CustomSubAgentRegistry`（`kernel/dispatch/host-ports.ts`）、`TeamModelRoutingPort`（`team/model-router.ts`） | 宿主，建派发器时 | 前两个必须 |
| `KernelSessionInputStore`（`kernel/session-lane.ts`）、`KernelToolOutputStore`（`kernel/tool-output-store.ts`）、`KernelBackgroundJobOutputStore`（`kernel/background-jobs.ts`）、`ContextPayloadStore`、`ContextMigrationEventSink`、`RetrievalPayloadStorePort`、`RetrievalStateStorePort`、`SessionLedgerLocator` + `SessionStoreDeps`、`ExecutionSpanScopeFactory` | 宿主给持久实现；不给就用包内的内存实现 | 可选 |
| `McpAuthorizationProvider`、`VelarModArchiveSignatureVerifier`、`AgentModPackReader`、`RemoteHostServicePorts` | 宿主，建对应连接器时 | 按场景必须 |
| `AgentSessionCatalogPort`、`AgentSessionLeasePort`、`AgentBackgroundAgentPort`、`AgentBackgroundAgentControlPort`、`AgentSessionEventPort`（`session/contracts.ts`、`event-port.ts`） | 产品 Session 服务的宿主（Termel） | 用这些服务时必须 |
| `AgentCapabilityRuntime`、`CreateAgentKernelModuleOptions`（`kernel-module.ts`） | 宿主，挂进 Kernel 时 | 挂内核时必须 |
| `AgentHostFacts`（取代 `AppRuntimeFacts` 的进程级可变单例；P1-3 后改由 system 的提示词贡献者提供） | 宿主，建执行栈时 | 可选 |
| 环境变量：`AgentEnvironmentVariables` 表 | 宿主设置 | 可选 |

宿主端口的门禁核对（`hostPort`）：门禁现在写死找 `ctx.system.xxx`，agent 的工具调的是扁平的 `ctx.xxx`，第一轮登记时不填 `hostPort`（门禁允许，platform 就没填），在第 3.5 节第 4 条的门禁泛化之后再登记 `AgentToolContext`。

### 3.3 `contract/constants.ts`：常量表

只放 `Object.freeze` 的表、`as const` 的字符串身份与 `typeof` 派生别名；每个数字一句中文说明；工具说明与 schema 里的数字用模板字符串引它。

| 常量 | 内容 ← 现在的位置 |
| --- | --- |
| `AgentToolNames` + `AgentToolName` | 20 个内置工具名（`tooling:map/read/replace`、`context:recall/handoff/distill`、`directive:list/upsert/archive`、`goal:get/create/update`、`plan:get/update`、`agent:dispatch/run_workflow`、`job:read_output/wait/cancel`、`interaction:confirm`）+ 租约协议的 `tooling:catalog`、`tooling:schema`（← `protocol/lease.ts:21,24`）；`SoloRunPlanPreparer.ts`、`ToolSpaceBootstrapPlanner.ts`、`coding/tool-dedupe.ts`、`ContextGovernanceSession.ts:52` 写死的工具名全部改引它 |
| `AgentToolCategoryByName` + `AgentToolCategoryId` | 每个工具唯一类别（agent-control、context、planning、interaction），同 `SystemToolCategoryByName` |
| `AgentIdentity` | `builtinModId: 'velaros.agent.builtin'`（← `BuiltinAgentMod.ts:44`）、`kernelModuleId: 'velaros.agent.runtime'`、`capabilityId: 'velaros.agent'`、`executionPermission: 'agent:execute'`（← `kernel-module.ts`）、`remoteHostToolCategory: 'remote-host'`（← `remote/contracts.ts:7`） |
| `AgentProtocolVersions` | `agent`（← `protocol/version.ts`）、`agentCapability` 与 `agentCapabilityApi`（← `protocol/agent-capability.ts`）、`externalAgentBridge`（← `protocol/external-agent-bridge.ts`）、`chatStorageSchema`（← `CHAT_STORAGE_SCHEMA_VERSION`）、`sessionArchive`（← `session/archive.ts`）、`contextRetrievalIndex`（← `ChatContextRetrievalIndexVersion`） |
| `AgentErrorCodes` + `AgentErrorCode` | 新立：`contextEpochStale`（← `'KERNEL_CONTEXT_EPOCH_STALE'`）、`sessionRunInterrupted`、`modStaleSnapshot`、`sessionLeaseConflict`、`mcpAuthorizationRequired`、`toolInputReuseInvalid`、`workflowBudgetExhausted`、`workflowAborted`、`toolUnavailable`（取代 `ExecutionPolicy.ts:769` 的文字正则）、mod 导入的 30 余种失败、技能市场与技能文件的 15 个串码（`skill-market-entry-missing`、`skill-frontmatter-name-missing`…）；8 个错误类不出包，外面只认码 |
| `AgentEnvironmentVariables` | `VELAROS_TOKENIZER_ENGINE`（← `agent/context/tokenizer.ts`）、`VELAROS_REMOTE_NODE_URL`、`VELAROS_REMOTE_NODE_PAIRING_CODE`（← `remote/mcp/stdio-entry.ts`） |
| `ChatRuntimeEvents`、`StreamRuntimeStateKinds` | ← `protocol/types/chatRuntime.ts` 的对象字面量与三组 `*_STREAM_RUNTIME_STATE_KINDS`（Desktop 7、Workbench 5 处） |
| `AgentFieldValues` | `reasoningLevel`、`thinkingDepth`、`runProfileId`、`runProfileSelectionId`、`toolSurfaceProfileId` 五组取值（← `protocol/constants/typedFieldAsserts.ts`） |
| `AgentStepLimits` | 执行步数与团队步数的上下限与缺省（← `protocol/constants/steps.ts`） |
| `AgentContextThresholds` | `highWatermarkPercent`、`compactionPercent`（← `contextUsage.ts`，Desktop 在用）；`ContextGovernancePresets`、`ContextGovernancePresetNames`、`contextDedupeVetoTarget`（← `residency/governanceConfig.ts`、`admission.ts`，Desktop 做实验分臂用） |
| `AgentToolLimits` | 写进工具说明与 schema 的上限：工具页查询页大小（← `ToolSpaceSchemas.ts` 的 `ToolSpaceQueryPageLimitMax` 与 240/120/12/24/50/8）、长期指令条数与长度（← `ActiveDirectiveLimits`）、目标/计划字段长度（2000/500/12/20）、job 等待超时（300000/120000）、dispatch 附件 20 与 workflow 附件 12（顺手统一）、workflow 的 `MaxWorkflowAgents`/`Rounds`/`ValueBytes`、结构化输出 `MaxStructuredOutputBytes`/`SchemaBytes`、`readToolSchemaDiscoveryNames` 的 12、召回缺省 8/8000、模型可见工具结果上限 `ModelToolResultMaxSerializedLength` |
| `ExternalAgentBridgeLimits` | 回环地址、端口区间、单帧上限、配对寿命、队列上限、事件窗口、失败次数、封禁时长（← `bridge/*.ts`，Desktop/Termel 在用） |
| `McpLimits` | `connectTimeoutMs`、`callTimeoutMs`（← `McpClientConnection.ts`） |
| `VelarModArchive` | 扩展名 `.velarmod`、签名文件名、导入上限（← `VelarModArchiveImporter.ts` 的 8 个数字） |
| `AgentModAxes` | 贡献轴名、只放数据的轴、必须带载荷的轴、已接线的 hook 事件与 seam 种类（← `protocol/mods.ts`、`AgentModLoader.ts`、`AgentModSeams.ts` 里现在是可变 `Set` 还出包的那几个） |
| `TurnContextFormat` | 块起止标签、mid-run 说明前缀、进程代次（← `run-context/TurnContextFormat.ts`、`TurnContextLedger.ts`，Desktop 在用） |
| `AgentToolTransport` | `providerToolNamePattern` 以字符串给出（← `tools/ToolIdentity.ts` 的正则） |

不进常量表的数字：约 150 项超时、缓冲、保留条数、阈值进 `utils/tuning.ts` 的 `AgentTuning`（例如 `ContextUsageCalibrator` 的三个校准系数、`contextBudget.ts` 的 5 个预算、`contextUsage.ts` 其余 18 个、`SubAgentProgressLedger` 的 5 个、`StreamTurn`/`QueryLoop` 的 7 个、`SessionToolAllocator` 的熔断阈值 3）；规则名单（厂商错误码、执行状态集合、源码扩展名…）留在各自 utils 文件；类里固定用的文案写 `private static readonly`。

### 3.4 要删的现有导出

1. **入口**：删 20 个——`./runtime`、`./host`、`./node`、`./chat-stream`、`./run-context`、`./mcp`、`./mods`、`./bridge`、`./session`、`./remote`、`./remote/mcp`、`./protocol`、`./protocol/agent-capability`、`./protocol/execution`、`./protocol/external-agent-bridge`、`./protocol/lease`、`./protocol/message`、`./protocol/mods`、`./protocol/observability`、`./protocol/session`；留 `.`、`./tool-contract`，新增 `./contracts`，`./chat` 重做。
2. **别名**：全部 48 对，含 `docs/public-api-policy.json` 的 9 个弃用别名（`AgentQueryLoop`、`AgentQueryTurnHelper`、`AgentRuntimePromptStateBuilder`、`AgentSoloModeStreamLoop`、`AgentStreamTurnHelper`、`AgentTurnHelper`、`ContextBuilderHelper`、`RetryPolicy`、`ToolResults`）与 22 个支持别名（`Exec*`、`AgentStreamConsumerHelper`、`ChatMessageHelper`、`AgentHistoryMessageHelper`、`AgentStreamDiagnostic*`、`ToolRegistryHelper`、`AgentTurnHistoryHelper`…），以及没登记在策略里的 17 对：`AgentModHookDispatcher` 一族 7 个、`AgentRunContextHelper`、`AgentTurnContextPayloadBuilder`、`AgentRuntimeHelper`、`AgentProvider`、`ResolvedAgentRuntime`、`BuiltInPromptCatalog`、`sanitizeModelHistoryForProvider`/`sanitizeModelMessageForProvider`/`assertValidModelHistoryForProvider`/`validateModelHistoryForProvider`。
3. **没有任何消费方的 1,659 个符号**（按声明去重）：全部不出包，变成包内实现。整个目录零消费的有 `agent/AgentLoop.ts`、`LoopRuntime.ts`、`QueryLoop.ts`、`QueryTurn.ts`、`SoloLoop.ts` 与全部 `Solo*`、`control-plane/*`、`history/*`（除 `TurnHistory`）、`model/*`、`stream/*`（除内联思考标签与生成产物读取）、`kernel/context-epoch.ts`、`controller.ts`、`prefix-shape.ts`、`provider-events.ts`、`session-lane.ts`、`tool-*.ts`、`coding/*`、`sub-agent/*`（除 `SubAgentSessionStore`、`SubAgentTypeRegistry` 的类型）、`tools/*` 的绝大部分、`tool-contract/ForgivingSchema.ts`、`concepts.ts`、`remote/*`。
4. **零件，不出包，宿主改用整件**（迁移表草稿，第 6 步写进 ADR 0008）：

| 现在出包 | 收口后 |
| --- | --- |
| `SoloStreamLoop`、`QueryLoop`、`TurnRunner`、`StreamTurn`、`QueryTurn`、`RunContext`、`ContextBuilder`、`PromptStateBuilder`、`ModelRuntime`、`AgentRunner` 直接 new | `createAgentExecutionStack(options)`；Runner 经 `createRunner` |
| `ToolExecutor`、`ToolExecutionPolicy` 直接 new（project 测试） | `ToolContractExecutionFacadeApi` 或执行栈；测试挪到仓库层 `tests/` |
| `configureAppRuntimeFacts` | 执行栈选项里的 `AgentHostFacts` |
| `activeDirectiveTools` 等 11 个工具集合 | `agentTools` + `createBuiltinAgentModDefinition` |
| `defineVelaTool`（Desktop 1、Workbench 1） | `agentToolContracts.define` |
| `ContextResidencyLedger`、`JsonlContextMigrationEventSink`、`compareStableStrings`（Desktop 各 1，调试面） | 经 `ContextGovernanceRegistryApi` 的只读诊断方法 |
| 协议 zod schema 值（`ToolCatalogSnapshotSchema`、`GuidanceRelayPlanSchema` 等） | `agentWire` / `guidanceRelay` 的解析方法 |
| 错误类 `AgentSessionLeaseConflictError`、`McpAuthorizationRequiredError`（Termel） | 按 `AgentErrorCodes` 判断 |

### 3.5 与标准冲突、需要人拍板的地方

1. **zod 先行的协议类型**。`protocol/*.ts` 有 70 个类型是 `z.infer<typeof XxxSchema>`，schema 是值；标准要求 types 零值、只引 types 与合同。建议：类型改成 `types/agent.ts` 里手写的类型别名，schema 放 `utils/wire/` 并写成 `const XxxSchema: z.ZodType<Xxx> = …`（或 `satisfies`），编译期保证两边一致；project 的 `utils/schemas/` 是先例。代价：约 70 个类型手写一遍，协议改动要改两处。备选：给门禁开「schema 文件」例外（types 可以 `import type` 某个登记的 schema 文件），要改标准与门禁。
2. **可移植文件只能一个且不许 import**。agent 的可移植数据约 3,800 行，全部进 `types/agent.ts`；`SerializedError`、`ErrorCode` 等要放本地同形副本，由仓库级一致性测试守着（同 `SystemShellKind`）。带方法的协议类型（`ToolExecutionApi`、`RunProfileRuntimePolicy`、`ToolExposurePolicy`）搬出可移植文件。
3. **工具契约是不是单独成包**。六个空间包只为写工具就把整个 agent 运行时列为 peerDependency；按「一包一义」与「出现独立消费者才成包」，`tool-contract/` + 工具相关协议类型（`ToolPermission`、`ToolCategoryDefinition`、`ToolCapabilitySchema`…）已经满足独立成包（例如 `@velaros-ai/tool-contract`）的条件。本方案按「先包内目录」写，`toolkit` 与 `tools/AgentToolContracts` 的边界已经按将来能整块搬走来划；要不要拆由你定。同类候选还有 `connectors/` 里的外部 agent 桥（Desktop、Termel 两个消费方）与 `product-session/`（只有 Termel）。
4. **门禁的宿主端口检查写死 `ctx.system`**（`check-module-ownership.mjs` 第 8 段 `node.expression.name.text === 'system'`）。agent 的工具上下文是扁平的约 45 个成员。建议登记表加 `hostPortProperty` 字段（缺省 `'system'`）；agent 要么把宿主提供的成员收进 `ctx.agent.xxx`，要么门禁支持「扁平端口」（按接口成员名匹配 `ctx.<成员>`）。在此之前 agent 不登记 `hostPort`。
5. **入口名不能带 `/`**：门禁用 `basename` 把 `exports/` 里的文件映射回子路径，`./remote/mcp`、`./protocol/*` 这类嵌套子路径无法登记，本方案全部并入四个平铺入口。
6. **1.0.0**：`scripts/agent/check-public-api.mjs` 对「有删除的变更」要求主版本号 +1，agent 现在 0.6.30，入口收口就是 `@velaros-ai/agent` 1.0.0；`docs/public-api-policy.json` 的 `rootEntrypoint.status: compatibility-umbrella`、`earliestRemovalMajor: 1` 正好到期。前五步不删入口与符号，只有「入口目标路径」变化（`dist/index.d.ts` → `dist/exports/index.d.ts`），按 `VELAROS_AGENT_PUBLIC_API_CHANGE=additive` 复核、升一个补丁号（如 0.6.31）即可。
7. **P0 搬家的归属**：P0-1（源码视图整条链）、P0-3（验证账本）搬进 project 会改发请求主链的字节（影响 B3 重放、前缀缓存指纹、`test/fixtures/provider-request-basic.json`），需要 agent 与 project 同一班车发版。建议作为五目录改造之后的独立一轮，不和搬家混在一起。
8. **工具面删改**（第 5 节）：删 `context:distill`、合并 `goal:get`/`plan:get`、删 `tooling:map` 的 `op=read` 等都是模型面变更，要在差量报告里点名。

## 4. 文件分类

### 4.1 统计

431 个源文件逐个判定（全表见**附录 A**，每行写了分类、去处和要特别处理的点）：

| 分类 | 文件数 | 怎么处理 |
| --- | ---: | --- |
| 纯函数 | 101 | 整文件进 `utils/<域>/`，每个函数上方补一句中文说明（全包顶层函数 1,346 个，外加 139 个从类里搬出的私有方法） |
| 混合（要拆）：类 + 函数/类型，或一个文件多个类 | 81 | 类各一个文件进 `impl/<域>/`，函数进 utils，类型进 types；其中 23 个文件一个文件多个类 |
| 混合（函数 + 类型） | 74 | 函数进 utils，类型进 types（`move-declarations.mjs` 能机械完成） |
| 入口（`index.ts` 转发文件，含三个稳定子路径入口） | 44 | 删除；只保留四个 `exports/*.ts` |
| 类型 | 41 | 整文件并进 `types/<域>.ts`；其中宿主要实现的端口进 `contract/requires.ts`（41 个文件带端口，见附录 A「端口 →」） |
| 类（已是类，只需补接口、搬家） | 37 | 进 `impl/<域>/`，类上方写接口 |
| 纯函数（无状态类改函数） | 21 | 类里一个实例字段都没有或只有常量字段：改成 utils 函数；公开面在用的（`ChatStreamProtocol`、`ChatMessages`）保留类加带接口的实例 |
| 需改类（闭包工厂/带方法的对象字面量） | 10 | `createAgentExecutionStack`、`createAgentKernelModule`、`createToolExecutionApi`、`createLinkedAbortScope`、`createUnattendedSubAgentApprovalPort`、`createProviderToolReferenceCanonicalizer`、`defaultDenyApprovalPort`、`defaultUnsupportedInteractionPort`、`defaultRuntimePromptFeaturePolicy`、`requestConfirmationTool` 等改成类（★） |
| 工具定义 | 10 | 收进 `impl/AgentTools.ts` |
| 类型 + 常量 / 常量 | 12 | 类型进 types，常量进 `contract/constants.ts` 或 tuning |

类的总账：134 个有状态类 + 31 个无状态类（改函数）+ 8 个错误类；新建 ★ 类约 30 个（第 2.2 节标 ★ 的，加 `AgentWire`、`AgentSessionKit`、`AgentLedgerFiles`、`GuidanceRelayKit` 几个公开工具集实例的类）；接口上要写中文说明的公开成员约 810 个；139 个不用 `this` 的私有方法要搬进 utils。

### 4.2 有模块级可变状态的文件（按标准改成类实例）

| 文件 | 状态 | 问题 | 改法 |
| --- | --- | --- | --- |
| `agent/AppRuntimeFacts.ts` | `const facts` 对象，`configureAppRuntimeFacts` 随时改写 | 进程级全局；`prompts/catalog.ts:115` 渲染时读它，测试之间互相污染 | 删；`AgentHostFacts` 走注入面，经执行栈选项进 `RunContext`（P1-3 后改 system 贡献） |
| `agent/run-context/TurnContextLedger.ts:15` | `let ledgerInstanceSeq` | 全局递增计数 | 改成 `TurnContextSessionLedgers` 的实例字段 |
| `agent/context/residency/ContextGovernanceSession.ts:80` | `const fingerprintByMessage = new WeakMap` | 跨会话共享的指纹缓存 | 改成 `ContextGovernanceSessionRegistry` 的实例字段 |
| `agent/context/residency/projection.ts:260` | `const renderedCharsByRecord = new WeakMap` | 全局投影缓存 | 归 `ContextResidencyLedger` 实例；投影函数经参数收缓存 |
| `agent/context/resources/FileContextCoordinator.ts:600` | `const coordinators = new WeakMap` + `fileContextFor` | 全局登记处，project 经 `./tool-contract` 取 | 新类 `FileContextRegistry`，实例 `fileContextRegistry` 带接口出包 |
| `tools/recovery/ToolInputReuse.ts:40,350` | `const reusableSchemas = new WeakSet`、`const claims = new Map<string, Promise<void>>()` | 前者给 schema 打全局标记；后者是按身份串行化保存的锁表，全进程共享 | 标记改成 schema 对象上的品牌字段；锁表收进 `ToolInputReuseStore`，归 `ToolExecutor` 持有 |
| `tool-contract/examples.ts` | `DefaultToolContractExampleRegistry`（带 Map 的进程单例） | `defineToolRuntimeSpec` 定义工具时顺手写进全局表（隐藏副作用），project 的审核脚本读它 | 示例本来就在工具规格上，需要全集时从工具集合收；登记表保留为带接口实例 `toolContractExamples`，但去掉副作用写入 |
| `tools/tool-space-resolver.ts:128` | `const PluginBackedToolCategoryIds = new Set()`，整个出包 | 恒空，外面能往里加 | 删（死代码，见 1.6） |
| `agent/control-plane/SessionToolAllocator.ts` 末尾 | 单例 `sessionToolAllocator`（带 `unresolvedRequestCounts` Map） | 跨会话共享，没人用 | 删单例 |
| `agent/control-plane/AgentRunPlanLedger.ts` | 单例 `agentRunPlanLedgerFactory`（带递增 id） | 全局计数 | 文件末尾带接口的实例（标准允许进程唯一实例），或归执行栈 |
| `mods/AgentModLoader.ts`、`mods/AgentModSeams.ts` | `PayloadRequiredAxes`、`DataOnlyAxes`、`WiredSeamKinds` 是可变 `Set` 且出包 | 消费方能改注册机的判定 | 冻结数组进 `contract/constants.ts` 的 `AgentModAxes` |
| 未冻结的模块级对象/数组（89 个，其中 33 个出包） | `RunProfileDefinitions`、`ToolSurfaceFallbackChains`、`ContextGovernancePresets`、`DefaultContextGovernanceConfig`、`ExecutionModeRegistry`、`ChatRuntimeEvents` 前身、三组 `*_STREAM_RUNTIME_STATE_KINDS`、五组 `*Values`、11 个工具集合数组、`BuiltinAgentModToolCollections`、`ModelToolResultLimits` 等（附录 A 逐行标注） | 消费方能改 | 对外约定的冻结进 constants；规则数据冻结后留 utils；类里用的改 `private static readonly` |
| 无状态单例（16 个） | `contextBuilderHelper`、`agentToolResultHelper`、`messageHelper`、`chatSearchMessages`、`chatSearchRanking`、`chatSearchText`、`contextRetrievalReferences`、`toolArgsSchemaValidator`、`agentIntentPlanner`、`agentRunPlanComposer`、`agentRunPlanLedgerComposer`、`capabilityRunPlanner`、`contextRunPlanner`/`promptRunPlanner`/`recoveryRunPlanner`、`sharedRetryPolicy` | 没有可变状态，但实现文件的模块级只许放日志与带类型的导出实例 | 随所属类改成 utils 函数；`sharedRetryPolicy` 改带接口实例 |

### 4.3 要从「函数」改成「收接口」或改成类的 24 处

utils 只许引 utils、types 与合同；下面这些顶层函数现在直接用到了类（值或类型），不能原样搬进 utils：

| 函数 | 用到的类 | 改法 |
| --- | --- | --- |
| `createAgentExecutionStack`（`agent/runner/AgentExecutionStack.ts`） | new 了 `AgentRunner`、`ContextBuilder`、`ContextGovernanceSessionRegistry`、`ModelRuntime`、`QueryLoop`、`RunContext`、`SoloStreamLoop`、`TurnRunner` | 类 `AgentExecutionStack` + 同文件的对外工厂 |
| `assembleAgentMods`（`mods/AgentModHostAssembly.ts`） | new `AgentModLoader` | 类 `AgentModHostAssembler` + 工厂 |
| `createBuiltInPromptRegistry`（`prompts/catalog.ts`） | new `PromptRegistry` | 挪进 `impl/guidance/PromptRegistry.ts` 作对外工厂；段目录函数留 utils |
| `compileProviderSendRequest`（`agent/context/ProviderSendRequest.ts`） | new `UserTextPayloadPlanner`，引 `ProviderRequestCompiler` 类型 | 并成 `ProviderRequestCompiler.compileSendRequest` |
| `buildToolPayloadRefsForProviderMessages`（`agent/context/ToolPayloadReferencePlanner.ts`） | new `ToolResultCanonicalizer` | 类 `ToolPayloadReferencePlanner` |
| `fileContextFor`（`agent/context/resources/FileContextCoordinator.ts`） | new `FileContextCoordinator` | 类 `FileContextRegistry` |
| `GovernanceEpoch.ts` 的 `appendSummaryRecord`、`archiveOldSummaries`、`resolveSummaryTurn`、`shouldOpenGovernanceEpoch`、`measureProjectedTokens`、`collectCandidates`、`resolveLatestTurn`；`distill.ts` 的 `resolveGoalHint`；`ingest.ts` 的 `ingestHistoryIntoLedger` | `ContextResidencyLedger`（类型） | 形参改成 `types/residency.ts` 的最小形状 `ResidencyLedgerView`（只列它们真用的方法） |
| `completeProviderTurnSnapshot`（`kernel/provider-events.ts`）、`recordKernelContextEpochDiagnostic`（`kernel/context-epoch.ts`）、`recordKernelPrefixShapeDiagnostic`（`kernel/prefix-shape.ts`） | `ProviderTurnEventReducer`（类型） | 形参改 `types/records.ts` 的 `ProviderTurnRecorder` |
| `defineToolRuntimeSpec`、`defineToolContract`、`buildToolContractDescription`、`buildToolRuntimeSurfaces`（`tool-contract/define.ts`） | `ToolContractExampleRegistry`（类型） | 形参改 `types/toolkit.ts` 的 `ToolExampleSource` |
| `applySoloContextDegradeAction`（`agent/SoloContextDegradeActionExecutor.ts`） | `ContextGovernanceSessionRegistry`（类型） | 形参改 `types/loop.ts` 的 `GovernanceSessionLookup` |
| `translateMcpTool` 一族（`tool-library/mcp/mcpToolTranslation.ts`） | `McpClientConnection`（类型） | 形参改 `types/connectors.ts` 的 `McpToolCaller` |

另外 4 个类型文件引用了类（`agent/runner/AgentRunnerTypes.ts`、`agent/runner/host-ports.ts`、`kernel/dispatch/host-ports.ts`、`tool-library/KernelToolContext.ts` 引 `ExecutionEventBus`、`PrimaryAgentProfile`、`QueryLoop`、`SoloStreamLoop`；`tool-library/context/CodingSessionTypes.ts` 引 `RuntimeReminderScheduler`）：公开的改引 provides 登记的接口（types 可以引 contract），`AgentRunnerTypes.ts` 的 `AgentRunnerInfrastructure` 改名 `AgentRunnerOptions` 挪进 `impl/runner/AgentRunner.ts` 当「以类名开头的配套接口」。

### 4.4 全表

见文末**附录 A**（431 行，按现目录分组）。

## 5. 工具面

路径未写前缀的都相对 `packages/agent/src/`；`Desktop:`、`Workbench:` 指两个姊妹仓。execute 列是「顶层语句/含嵌套的总语句」，门禁上限 4 条（含嵌套）。

### 5.1 全部模型面工具

| # | 工具 | 组 | 作用 | 定义 | execute · 交给谁 | 挂载与常驻 | 问题 |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | `tooling:map` | 工具发现 | find/page/map 查工具页状态与激活路径（另有 `op=read` 读技能） | `tool-library/builtin/Categories.tool.ts:33-80` | 2/2 → `Categories.ts:51 runToolSpace` → `ToolSpaceQueries.ts` | Desktop 常驻；bootstrap 阶段强制 toolChoice（`agent/ToolSpaceBootstrapPlanner.ts:197`） | 示例 query 是英文；参数说明写「ToolOS v2」「map/batch」；schema 裸数字 240/120/12/24/50/8 |
| 2 | `tooling:read` | 工具发现 | 读 `skill:<id>` 技能正文；外部技能首读弹确认 | `Categories.tool.ts:82-109` | 1/1 → `ToolSpaceSkillRead.ts:92` | Desktop 常驻；Workbench 未注册 | schema 裸数字 180/12 |
| 3 | `tooling:replace` | 工具发现 | 换入/换出工具页，`capability:*` 整类激活并申请授权 | `Categories.tool.ts:111-144` | 1/1 → `ToolSpaceReplace.ts:210`（约 230 行） | Desktop 常驻 | 回执「ContextOS 工具页替换已处理」；裸数字 180/8/240 |
| 4 | `context:recall` | 上下文 | 召回历史对话、工具载荷、证据、终端日志、文件旧版本 | `ContextRetrieval.tool.ts:20-169` | **16/29**，逻辑全在 execute 里 | 恒常驻（`QueryTurn.ts:383`、`StreamTurn.ts:337` 强制追加，`providerRequest/floor.ts:173-180` 断言） | 超门禁；回执英文 3 处；说明写死「默认 8」「默认 8000」 |
| 5 | `context:handoff` | 上下文 | 请用户批准把任务转交到新会话 | `ContextHandoff.tool.ts:29-67` | 4/5 → `ctx.conversation.requestHandoff` | **Desktop、Workbench 都没注册**，模型调不到 | `prompts/segments/runtime.ts:69-72` 那句提示永远不会出现 |
| 6 | `context:distill` | 上下文 | 只把事实便签留在回执里（已 `@deprecated`） | `ContextDistill.tool.ts:54-90` | 2/2 | 不在内置 mod，也不在任何宿主 | 死工具 |
| 7–9 | `directive:list` / `upsert` / `archive` | 长期指令 | 列出、写入/更新（上限 8 条）、按 id/标题/类型归档会话级长期约束 | `ActiveDirectives.tool.ts:17-179` | 2/2、2/2、1/1 → `ActiveDirectives.ts` | Desktop 常驻；Workbench 未注册 | 报错英文 `ActiveDirectives.ts:204,214`；archive 的「用法」「注意」两句几乎一样 |
| 10–12 | `goal:get` / `create` / `update` | 目标 | 读、建（已有 active 就复用）、改目标与步骤与生命周期 | `Goals.tool.ts:98-416` | 4/4、7/9、**22/29** | 目标模式保护集（`SoloRunPlanPreparer.ts:188`） | create、update 超门禁；回执与报错英文 6 处；中文句夹半角标点 |
| 13–14 | `plan:update` / `get` | 计划 | 维护界面上的执行计划；读计划与任务、推荐动作、执行建议 | `Plans.tool.ts:63-315` | **21/23**、4/4 | 计划模式保护集（`SoloRunPlanPreparer.ts:187`） | update 超门禁（`findPlanArtifact`、`readPlanLifecycle` 也写在工具文件 :28-53） |
| 15 | `agent:dispatch` | 子 agent | 新派、续跑、中断子 agent（sync/async） | `DispatchAgent.tool.ts:9-107` | 4/5 → `ctx.dispatchSubAgent` | Desktop 常驻；子 agent 里禁用 | 示例 5 条英文；说明写死「30 分钟」（宿主可调，`ExecutionLimits.ts:60`）、「20 条」；描述 1,793 字符贴着 1,800 软预算 |
| 16 | `agent:run_workflow` | 子 agent | 声明式、有界的多子 agent 编排，代码侧归约/投票 | `AgentWorkflow.tool.ts:12-83` | 2/3 → `ctx.runAgentWorkflow` | 只有 Desktop 注册 | 说明写死「上限 8」「32 帽」（`SubAgentDispatcher.ts:274`）；schema 6,828 字符；附件上限 12 与 dispatch 的 20 不一致 |
| 17–19 | `job:read_output` / `wait` / `cancel` | 后台作业 | 读异步子 agent 作业输出、阻塞等待、取消 | `BackgroundJobs.tool.ts:21-164` | 4/6、3/4、4/6 | read、wait 在 Desktop 常驻 | 回执英文；schema 里 300000/120000/20，execute 又写一遍 `?? 120_000`（:117） |
| 20 | `interaction:confirm` | 交互 | 人工确认闸，拒绝就终止本次执行 | `kernel/execution/confirmation-tool.ts:30-70`（手写 `ToolContractRuntimeSpec`，没走 `defineVelaTool`） | 2/2 → `ctx.approval.awaitConfirmation` | 不在内置 mod；Desktop 注册并常驻 | 示例写成散文不是 JSON |
| — | `mcp.<server>:<tool>` | 动态 | MCP 服务器工具翻译 | `tool-library/mcp/mcpToolTranslation.ts:158-222` | 5/11 | Desktop 调用时不传类别，全部落进 `agent-control` | 描述多为服务器原文英文 |
| — | `remote.<host>:<tool>` | 动态 | 远程节点工具 | `remote/remote-tool.ts:53-109` | 3/8 | Termel | `remote-tool.ts:1` 自引用根入口 |
| — | `tooling:catalog`、`tooling:schema` | 租约自恢复 | 外部 agent 经租约协议重读工具目录与参数结构 | `tool-contract/discovery.ts:10-47`（纯 JSON 描述，由 `ToolContractExecutionFacade` 常驻返回） | — | `./node` 门面 | 不是 `VelaTool`，门禁的工具计数看不到；名字进 `AgentToolNames`，上限 12 进常量表 |

**挂载现状**：`mods/BuiltinAgentMod.ts:47-59` 收 9 个集合共 18 个工具（没有 `context:distill`、`interaction:confirm`），但生产宿主都不走这份清单：Desktop 在 `Desktop:src/main/tools/collections/builtin/Collection.ts:2-77` 自己挑了 17 个内置工具加 `interaction:confirm`，**漏了 `contextHandoffTools`**；Workbench 在 `Workbench:src/main/agent/WorkbenchAgentControlTools.ts:98-112` 只挑 12 个。常驻与保护的来源分散在五处（Desktop 常驻清单、Platform 保护集 `SoloRunPlanPreparer.ts:187-194,212-218`、recall 地板、Workbench 按类别常驻、Desktop 子 agent 禁用名单）。改造后宿主统一从 `agentTools` 与 `createBuiltinAgentModDefinition` 取，漏挂就不会再发生。

**收进一个工具文件前要先解决**：① 导入循环（第 1.6 节，已复现 TDZ 报错）；② execute 超过门禁 4 条（含嵌套）的有 8 个：`context:recall` 29、`goal:update` 29、`plan:update` 23、`goal:create` 9、`job:read_output` 6、`job:cancel` 6、`context:handoff` 5、`agent:dispatch` 5，全部下沉到 `impl/builtin/` 的执行类（后四个只是守卫与字段映射，下沉后 execute 一行）；③ 约 60 个说明与 schema 里的裸数字进常量表；④ `interaction:confirm` 改用 `defineVelaTool`；⑤ 20 个工具都没有 `inputReuse`（只有 system、project 在用），是否给 `goal:update`、`plan:update` 这类大入参工具开，单独评估。

### 5.2 简化候选（判据：别的工具替代得了、只剩仪式感才删；没人用过但有独特能力的不删）

| 工具 | 判定 | 理由 | 风险 / 谁在用 |
| --- | --- | --- | --- |
| `context:distill` | **删** | 自标 `@deprecated`（`ContextDistill.tool.ts:92`）；不在内置 mod、不在任何宿主；容量治理已自动化；配套常量 `ContextEpochRequestToolName`（`ContextGovernanceSession.ts:52`）没人用 | 根入口导出 `contextDistillTools`，删除属入口变更；5 个测试要改（`test/contextDistillTool.test.ts`、`contextAutomaticToolSurface.test.ts`、`builtinToolCapabilityTruth.test.ts` 等）；ui 包渲染历史记录的名字保留 |
| `goal:get` | **并入 `goal:update` 的空调用** | `goal:update` 说明已写「所有字段都不传则视为读取当前目标、不报错」（`Goals.tool.ts:261`）；活动目标每轮以 active-task 块注入（`ProviderTurnRequestHelper.ts:360-376`） | 先把 :337-339 没有目标时抛「No active goal exists. Use goal:create first.」改成返回 `status:'none'`；引用方 `SoloRunPlanPreparer.ts:188`、`Desktop:src/main/agent/unattended/UnattendedTaskToolPolicy.ts:99`、ui 目录、`tests/ui/toolTargetSummary.test.ts:104` |
| `plan:get` | **并入 `plan:update` 的空调用** | 空调用已等价（`Plans.tool.ts:81,199-206`）；计划预览每轮都在系统提示里（`prompts/segments/task.ts:17-24`） | 它多出的 task、recommendedAction、executionAdvice 三字段先确认还有没有价值；`coding/tool-dedupe.ts:6-11` 会拦重复 `plan:update`，要放行空调用 |
| `tooling:map` 的 `op="read"` | **删这一路**，`tooling:read` 保留 | 与 `tooling:read` 同一路径（`ToolSpaceSchemas.ts:284-291,308-317,390-391` → `readRequestedSkillPages`） | 技能索引、`SkillGateAlwaysKeptToolNames`、`PromptState.ts:272` 都认 `tooling:read` |
| `job:cancel` 与 `agent:dispatch` 的 `interrupt` | **二选一，建议留 `job:cancel`** | 后台作业只有子 agent 一种来源（`SubAgentDispatcher.ts:925-928`），两条路都是中止 worker（:1023 与 :1026-1051），模型要同时记 thread_id 与 job_id | interrupt 的测试 `test/agentDispatchInputContract.test.ts`、`subAgentThreadRetention.test.ts`；`job:cancel` 在 `DesktopAgentRuntimePolicy.ts:275` |
| `directive:list` | **并入 archive 或降为非常驻** | 活动长期指令每轮以 pinned-evidence 注入（`ProviderTurnRequestHelper.ts:378-387`，最多 8 条，与上限一致）；archive 能按标题/类型匹配，不需要 id | Desktop 让它常驻，测试 `DesktopAgentRuntimePolicy.test.ts:205-207` 有断言 |
| `context:handoff` | **保留，补接线** | 独特能力：用户批准的会话转交；Desktop 渲染与治理层都在等它（`Desktop:src/main/agent/context/ContextGovernanceWiring.ts:172`） | 要么两个宿主注册（改造后从 `agentTools` 取就自然注册），要么承认未上线 |
| `goal:create` | 保留，改说明 | 模型自主建目标与界面目标卡依赖它 | 显式目标模式下运行时已自动建目标（`agent/SoloLoop.ts:501-504`），「目标模式刚开始时创建」过时 |
| `agent:run_workflow` | 保留 | 有界编排与代码侧 filter/dedupe/majority_vote，多次 dispatch 替代不了 | 只有 Desktop 注册 |
| `job:wait` | 保留，写清分工 | 回合中途按作业定点等待 | 与收尾自动停泊（`SoloBackgroundCompletionGate.ts:43-90`）部分重叠；可选与 `read_output` 合成按 action 分支的一个工具 |
| 其余（`job:read_output`、`agent:dispatch`、`context:recall`、`tooling:replace`、`directive:upsert/archive`、`goal:update`、`plan:update`、`interaction:confirm`、MCP、远程） | 保留 | 各有唯一能力 | MCP 默认类别改成独立的 `mcp` 类，别混进控制面 |

**工具发现这一块的仪式感**在运行时而不在工具数：bootstrap 强制 toolChoice 到 `tooling:map`（`ToolSpaceBootstrapPlanner.ts:189-201`），同文件又写着工具已经「填满预算常驻」，建议复评强制发现；`tool:*` 换入缺授权会自动申请整类（`ToolSpaceReplace.ts:291-317`），`capability:*` 整类激活只剩「批量开一类」的价值；工具页卡片同一个状态用 `availability`、`toolOsState`、`nextAction`、`activation.method`、`access.*`、`resident`、`schemaState` 七个字段各说一遍（`ToolSpaceQueries.ts:144-169`），其中 `schemaState` 恒为 visible、`nextAction` 的 `describe` 从不产生；replace 回执的 `recommendedPageIn`、`recommendedTools`、`userActionHint` 恒空，`skippedPages` 与 `unavailableTargets` 重复（`ToolSpaceReplace.ts:404-413`）。这些是瘦身，不删工具。结构上另一个要人拍板的：`goal.steps` 与 `plan` 是两本步骤账（`Goals.tool.ts:148,180,301` 写明「不替代 plan:update」），目标模式里模型要双写。

### 5.3 提示词问题清单

**冲突与优先级不清（18 条，列关键的 12 条）**

| # | 位置 A | 位置 B | 建议 |
| --- | --- | --- | --- |
| C1 | `agent/ToolSpaceBootstrapPlanner.ts:153`「不要在未确认工具页状态、依赖和 schema 前直接用现有工具凑答案」 | `Categories.tool.ts:40`「已在当前工具列表中提供完整参数的工具可直接调用」 | 删 A，改成「只查缺失能力」 |
| C2 | `Goals.tool.ts:261`「所有字段都不传则视为读取当前目标、不报错」 | 同文件 :338 抛「No active goal exists. Use goal:create first.」 | 没有目标时返回 `status:'none'` |
| C3 | `Goals.tool.ts:257`「status=complete…不用逐个 complete_step」 | `Goals.ts:299`「…Use complete_step, skip, or update failed steps first」 | 报错改中文、只指向 failed 步骤 |
| C4 | `Plans.tool.ts:117-120`、`Goals.tool.ts:34-36`「稳定步骤 ID；已有步骤可复用」 | `Plans.tool.ts:77`「步骤没有 id，别自造 "step-1"」，而回执里步骤其实带 id（`StepRefs.ts:55`） | 统一口径，schema 与说明一致 |
| C5 | `Goals.tool.ts:103`「…或进入受阻审计」 | :258 与 `SoloFinishingGate.ts:162`「不需要等待多轮审计」，而 `SoloGoalLifecycle.ts:130-152` 仍在累计 `blockedAuditTurns` | 删「受阻审计」概念或删计数 |
| C6 | `Goals.tool.ts:139`「目标模式刚开始且尚未存在活动目标」；`SoloFinishingGate.ts:159`「如果还没有目标，先调用 goal:create」 | `SoloLoop.ts:501-504` 显式目标模式自动建目标，这个分支走不到 | 改成「非目标模式下自主建目标」，删收尾门那句 |
| C7 | `Goals.tool.ts:156`「重复创建是幂等读取，不会覆盖当前目标」 | :204 只在 active 时复用，暂停的目标会被同 id 覆盖（`Goals.ts:13,176`） | 写清或改成拒绝 |
| C8 | `BackgroundJobs.ts:30,70`「返回里会带「命中 K/N 行」」 | 实际输出 :164「[filter matched K/N line(s)…]」 | 回执中文、与说明同源 |
| C10 | `Plans.tool.ts:75`「用户明确选择计划模式…按该要求等待确认」 | 没有任何提示词段读 `userRequestedPlan`（`PromptState.ts:242` 赋值没人消费），`ExecutionModeRegistry.ts:41` 却称提示词面由它驱动 | 补 plan-mode 段或删这句 |
| C11 | `DispatchAgent.tool.ts:27`「mode=async…之后用 job:read_output/job:wait 收束」 | 运行时收尾会自动停泊并被唤醒（`SoloBackgroundCompletionGate.ts:43-53`、`kernel/background-jobs.ts:606`） | 写明「可以直接结束本轮，等通知」 |
| C13 | `SoloTurnWindDown.ts:22`「请立即停止调用工具，基于现有进展给出结论」 | 目标模式 `SoloFinishingGate.ts:158`「必须继续推进，不能直接结束本次回复」 | 收尾提醒补「目标模式先 goal:update blocked」 |
| C14 | `coding/tool-dedupe.ts:95-96` 对重复 `tooling:read` 说「若工具页已换入，请等待下一轮…」 | `tooling:read` 读的是技能不是工具页；dedupe 还会拦 `plan:update` 的合法空读 | 按工具分文案，空调用放行 |
| C15 | `ToolSpaceActivation.ts:14-15`「本文件不认识任何具体能力」 | :162-167、:355-363 写死 `interaction:show_action_cards`（Workbench 没有这个工具） | 由注入描述符提供 |

其余 6 条：C9（`RuntimeRunPlanner.ts:255-256` 让「先读取对应工具页」而 `Categories.tool.ts:91` 说「不要用 tooling:read 读工具页」，且 read-page 动作从不产生）、C12（用户附加提示词 `catalog.ts:177-185` 与技能段谁排最后没定，`registry.ts:308-312` 先按 tier 排）、C16（`ToolDescription.ts:71`「模型面描述永不压缩」对 `Desktop:…/WebConversationToolService.ts:102-104` 截到 280 字符）、C17（handoff 提示写了但没挂）、C18（`catalog.ts:35`「简单任务直接完成」对 `SoloProcessUpdateCadence.ts:17-19` 连续两个纯工具回合就催汇报，不看任务大小）。

**冗余（同一规则写在多处，19 类）**：「工具状态 → 下一步」整个阶梯写了 6 处（`Categories.tool.ts:57`、`ToolSpaceActivation.ts:236-375`、`ToolSpaceQueries.ts:421-446`、`tools/tool-space-recovery.ts:20-23`、`tool-space-resolver.ts:309-320`、`ToolSpaceReplace.ts:184-205`）；「换入后下一轮才生效」写了 12 处；失败参数复用 5 处（其中 `ToolInputReuse.ts:37-38` 英文）；上下文自动整理 5 处；「优先用 thread_id 续跑」3 处；agent_name 用英文代号 2 处；Markdown/Widget/HTML 该用哪个在 `catalog.ts:137-170` 三段同时生效时重复；防循环三套机制阈值不同（`kernel/tool-loop-guard.ts:80` 2 次、:116 3 次，`ExecutionProgress.ts:54` 3 次，`tool-dedupe.ts:89-96`）；恢复提示两套几乎一样（`QueryLoop.ts:905-912` 对 `StreamTurn.ts:760-767`，`QueryTurn.ts:696-710` 对 `StreamTurn.ts:806-841`）；收尾停轮提示两套措辞（`SoloTurnWindDown.ts:21-23` 对 `QueryLoop.ts:306-313`）；schema 失败一次给 5 条 nextActions（`ToolArgsSchemaValidator.ts:283-285` 叠 `ExecutionPolicyFailures.ts:181-182`）；回执双份数据（`Plans.tool.ts:269-272` 同时回 `plan` 与 `steps`）。建议每条规则只留一个出处：工具说明管「怎么用」，提示词段管「何时用」，回执只给「下一步」。

**歧义与术语不一（20 类，关键的）**：上级 agent 有 7 种叫法（主 Agent、父 Agent、上级、上游角色、主控、上级主 Agent、parent agent），子 agent 4 种（子 Agent、sub-agent、子智能体、worker）；可见工具面有 5 个名字（当前工具列表、本轮 AI SDK tools、可见工具空间、动态工具空间、ContextOS 工具空间）；`availability` 与 `toolOsState` 两套状态词，loadable 在两套里语义不同（`tools/discovery-availability.ts:5-21,103-110`）；内部实现名直接给模型看（ContextOS、ToolOS v2、evidence ledger、CapabilityScopePolicy、折叠桩）；注入信封格式 10 种（`[系统]`、`[system]`、`[主控 relay 引导]`、`<sys_note>`、`<environment-context>`、`[context-dashboard]`、`[ContextOS retained context]`、`<agent-surface-context>`、`[system prompt · dynamic layer (current turn)]`…）；完成态目标用 `complete`、计划用 `completed`（`Goals.tool.ts:32` 对 `Plans.ts:37`）；计划入参字段叫 `step`、回执叫 `title`；「后台任务」撞名（`system:list-tasks` 与子 agent 作业通知 `kernel/background-jobs.ts:400,606,638`）；说明里写「bash 轮询」而系统里没有 bash 工具（`BackgroundJobs.tool.ts:49`）；对模型暴露架构说明（`DispatchAgent.tool.ts:62`「跨作用域派发属于具体能力，由能力包注册专用工具并注入端口」）。建议定一张术语表放进卡片，模型面只用表里的词。

**悬空与过时引用（15 处，关键的）**：`ContextRetrieval.tool.ts:49` 让「优先阅读 [置顶执行证据]/[动态检索句柄] 摘要」，这两个标记已没有生产者；`Categories.tool.ts:95` 说「「可按需读取的技能」索引」，全仓没有这个标题（实际是「# 命中 Skill」，`AgentSkillRepository.ts:332`）；`ToolSpaceSchemas.ts:65,366` 的「读取指定工具页元数据」「map/batch 模式」已不存在；reminders 调度器没有任何 producer（`coding/AutoVerification.ts:164` 引用的 `reminders/producers.ts` 已删，:227 引用已删除的 `summarize_current_dev_environment`）；`PromptState.ts:238-262` 算了 8 个没人读的快照字段；`ExecutionPolicy.ts:696-703` 的注释挂错了方法。

### 5.4 模型看得到的纯英文

按「模型看得到的全部字符串字面量」口径约 190 条（门禁口径 210 处，差在门禁还查用户可见的报错），集中在：`agent/StreamTurn.ts` 14、`execution/GuidanceRelayPlanner.ts` 15（辅助模型提示词）、`tools/recovery/ToolInputReuse.ts` 8、`FileContextCoordinator.ts` 8、`BackgroundJobs.ts` 6、`ContextRetrieval.tool.ts` 6、`OutputTruncationRecovery.ts` 6、`toolResultSerialization.ts` 6、`FileContextProjection.ts` 5、`ExecutionPolicy.ts` 5、`DispatchAgent.tool.ts` 5（示例）、`FetchSafety.ts` 5；用户可见的另有 `mods/VelarModArchiveImporter.ts` 31 条、`session/archive.ts` 12 条、`skills/*` 15 个错误串。两个系统性来源要单独改：zod 报错全英文（`ExecutionPolicy.ts:593` 把 zod issues 原样拼给模型；全仓无 `z.config` 本地化），系统提示词的 17 个英文段名（`prompts/catalog.ts:103,110,119,129,144,159,178,199`、`segments/runtime.ts:85,97,115,129,137`、`segments/task.ts:19,27`、`segments/shared.ts:186,199`）。**翻译之前**先把 `ExecutionPolicy.ts:769` 按文字正则归类改成按错误码归类，否则改文案会改变失败归类。所有模型面文字变更都要在差量报告里点名，并重算 project 的提示词审核指纹。

## 6. 风险与顺序

### 6.1 总体策略

- **先内后外**：第 1–5 步只动包内，所有入口、导出名、声明语义不变，六个空间包、Desktop、Workbench、Termel 都不受影响；第 6 步一次性收口（1.0.0），第 7 步登记治理。和 project 这两天走的顺序一致（`178d589` 只搬不改 → `63cefba` 合同归位 → `2d6c0ba` 类型归位 → `8d7513e` 工具收进一个文件）。
- **第 1–5 步不让任何现有导出名消失**：`check:agent-public-api` 把删除一个导出名当破坏性变更（要主版本号 +1）。所以这几步里凡是会让导出名消失的改动——删死代码（`PluginBackedToolCategoryIds`、`isPluginBackedToolCategory`、`PluginFeatureDescriptions`、`sessionToolAllocator` 都在根入口）、无状态类改函数（`TurnHistory`、`ExecPlanState`、`ChatMessages`、`chatSearchRanking` 等有外部消费方）、去掉模块级状态（`configureAppRuntimeFacts`）——都先保留原导出名做转调外壳，或者推迟到第 6 步一起删。
- **不登记也能看进度**：在第 7 步之前 agent 不进 `governed-modules.mjs`（一登记 `check:gates` 就红）；靠第 0 步给门禁加的 `--only packages/agent --report` 按规则计数，每一步报一次数，做燃尽。
- **每一步的「全绿」口径**：① `packages/agent` 下 `bun test test` 全过（现 830 条，只许因测试挪位而换位置，不许减）；② `bun run typecheck`（全仓）；③ `bun run --cwd packages/agent build` 后，读 dist 的下游包 system、project、browser、office、memory、computer 的 `bun run test`；④ `check:agent-arch`、`check:agent-public-api`、`check:agent-browser`、`check:agent-schemas`、`check:capabilities-schemas`、`check:conversation-semantics`、`check:code-style`；⑤ project 的 `test/project-guidance-drift.test.ts`；⑥ 仓库层 `bun run test:capabilities`。第 6 步起跑整条 `bun run check`。

### 6.2 步骤

| 步 | 做什么 | 怎样保持全绿 | 规模 |
| --- | --- | --- | --- |
| **0 准备**（不动 agent 代码） | ① 门禁加 `--only <包目录>` 与 `--report`（只计数不失败）；登记表加 `hostPortProperty`（缺省 `'system'`）或支持扁平端口；② 新脚本 `scripts/ownership/debarrel.mjs`：用类型检查器把「经 `index.ts` 转发」与「经包名自引用」的 import 改成指向声明文件的相对路径（本方案的分析脚本已验证能逐个名字解析到声明）；③ 解开跨包源码引用：`packages/project/scripts/model-guidance-audit.ts` 的 12 处 `../../agent/src/…` 与 14 个字符串路径改经 agent 入口（或挪到仓库层 `scripts/`），`tests/capabilities/tool-operation-approval.test.ts`、`scripts/mod/velaros-mod.mjs`、`scripts/agent/check-conversation-semantics.mjs`、`scripts/agent/check-schemas.mjs:18-25` 改经入口；④（建议）防线⑤词表补 `project`、`system:`、`office` 等（见 1.5 节末），当前违规记基线后棘轮归零 | 门禁新参数用负例实测；`--report` 对 system、platform 仍输出全绿 | 门禁约 60 行；新脚本约 200 行；跨包引用 6 处 |
| **1 去自引用、去 barrel**（行为不变） | `src/` 里 204 处 `@velaros-ai/agent*` 自引用改相对路径（顺带消掉 `tool-library` 的 TDZ 循环）；`src/` 内经 barrel 的 import 改指声明文件；`test/` 的 22 个 barrel 目标与 9 处 `@velaros-ai/agent/protocol` 同样处理；23 个入口文件改成逐个名字的显式转发（按类型检查器解析出的「导出名 → 声明文件」自动生成，根入口约 1,600 个名字，第 6 步收口时整体重写），之后删 29 个中间 barrel（`protocol/types/index.ts` 是真内容，不在内） | 入口导出的名字与声明逐个不变 → public-api 基线不动（`check:agent-public-api` 直接验证）；加一条检查：23 个入口与每个源文件各在全新进程里单独 import 都不报错（现在单独 import `src/tool-library/index.ts` 会报 TDZ） | 约 400 处 import、29 个文件删除 |
| **2 整文件搬家**（只搬不改） | `scripts/ownership/move-files.mjs` 按附录 A「去处」第一项搬：含类的文件先整个进 `impl/<域>/`，纯函数进 `utils/<域>/`，纯类型进 `types/<域>.ts`，`*.tool.ts` 先整个进 `impl/builtin/` 暂放，入口进 `src/exports/`（嵌套子路径暂时保留嵌套文件，门禁此时还没登记）；`package.json` 的 exports 目标改 `dist/exports/*`，子路径名一个不变；根 `tsconfig.json` 与 agent `tsconfig.json` 的 `paths` 改指 `src/exports/`。同一提交改所有按路径钉住 agent 源码的脚本：`scripts/agent/check-arch-boundaries.mjs` 约 25 个路径（防线④⑤⑦）、`check-browser-surface.mjs` 4 个入口、`check-schemas.mjs`、`check-conversation-semantics.mjs`，以及 project 审核脚本的 `GuidanceSources` 与 `bun packages/project/scripts/model-guidance-audit.ts --write-reviewed` 重算 `docs/engineering/project-model-guidance-review.json`（登记了 15 个 agent 源文件；要在不含别的实例未提交改动的干净 worktree 里重算），README 与 `docs/agent/*.md` 里的源码路径 | move-files 改写全仓相对 import（它扫 `packages/`、`tests/`、`scripts/`）；入口目标路径变了，按 `VELAROS_AGENT_PUBLIC_API_CHANGE=additive VELAROS_AGENT_PUBLIC_API_UPDATE=1` 复核重绑并升 0.6.31；`check:package-pack` 核打包内容 | 431 次 `git mv`；project 同类提交 138 个文件改写 724 处，agent 预计约 3,000 处；按域分 5–6 个提交（protocol→wire/types、tool-contract→toolkit、工具链、上下文三域、回合与运行、执行与记录与账本） |
| **3 拆混合文件** | `scripts/ownership/move-declarations.mjs`：约 1,000 个类型声明进 `types/<域>.ts`（宿主要实现的端口先原样进过渡的 `contract/requires.ts`）；23 个多类文件拆成一类一文件；8 个错误类进 `impl/errors/`；impl 文件里的顶层函数进 utils；31 个无状态类改函数（公开面在用的保留类加实例）；第 4.3 节 24 处改收最小形状或改成类；采纳第 3.5 节第 1 条后，70 个 `z.infer` 类型改手写 | 入口从新位置转发，导出名不变；声明文本移动可能改基线哈希 → additive 复核、升 patch | 约 1,000 个声明、50 个新文件 |
| **4 合同、接口、常量** | 每个类 `implements` 类上方接口（约 810 个成员逐个中文说明）；139 个不用 `this` 的私有方法进 utils；写 `contract/constants.ts`（第 3.3 节）与 `utils/tuning.ts`（约 150 项），写死的工具名全部改引 `AgentToolNames`；第 4.2 节的模块级状态逐个改掉；英文文案改中文——**先**把 `ExecutionPolicy.ts:769` 的文字归类改成按错误码归类，再翻 | 数字改引常量要做到模型看到的字节不变（schema 冻结与说明快照守）；约 45 个测试文件、165 行断言按英文文案写，翻译时同步改；模型面文字每一处在差量报告里点名并重算审核指纹 | 接口约 150 个；常量表约 20 张；英文约 200 处 |
| **5 工具文件** | 20 个工具收进 `impl/AgentTools.ts`，8 个超门禁的 execute（第 5.1 节）下沉到 `impl/builtin/` 六个执行类；分组与内置 mod 定义放文件末尾；`interaction:confirm` 改用 `defineVelaTool`；工具面删改（第 5.2 节）**单独一个提交**，拍板后做 | `test/builtinToolCapabilityTruth.test.ts`、`toolDescriptionBudget.test.ts`、`toolExampleWireShape.test.ts`、`toolExposureBudget.test.ts` 与 `check:agent-schemas` 守住模型面不变 | 约 1,800 行的工具文件 |
| **6 入口收口（1.0.0）** | 新 exports：`index.ts`、`contracts.ts`、`chat.ts`、`tool-contract.ts`；删 20 个入口与 48 对别名；provides 登记、实例与工厂标注公开接口；同一提交改仓内消费方：六个空间包的 import（`./protocol` 类型 → `./contracts`，`./tool-contract` 函数 → `agentToolContracts.*`，`./run-context` → 根入口工厂），project 的 9 个集成测试挪到仓库层 `tests/`（经 `ProviderRequestCompilerApi`、`ToolContractExecutionFacadeApi` 等公开面），两个 schema 检查脚本改经公开面；`baselines/agent/public-api.json` 按 breaking 重绑、agent 升 1.0.0、`docs/public-api-policy.json` 改写；写 ADR 0008（迁移表，第 3.4 节扩全） | 跑整条 `bun run check`；按全链发版手册：agent 升版重绑 API 基线、ipc 也钉 agent、`bun.lock` 工作区版本手改 | 下游在各自升级时迁移：Desktop 416、Workbench 51、Termel 17、Extension 3 个文件 import agent；大头是 `./protocol` 类型（可 codemod 改成 `./contracts`），值级约 190 个符号按迁移表改 |
| **7 登记治理** | `governed-modules.mjs` 加 agent 条目（在另一个实例的 project 条目提交之后）：`toolsFile: 'src/impl/AgentTools.ts'`、`toolDefiner: 'defineVelaTool'`、`portable: 'agent.ts'`、`tuning: 'tuning.ts'`、`browserSafeEntries: ['contracts.ts', 'chat.ts', 'tool-contract.ts']`、`environmentTable: 'AgentEnvironmentVariables'`、`layers`（第 2.3 节 13 层）、`hostPort` 暂不填；写 `MODULE.md` 十节、`spec/invariants.md`（把防线①②④⑦、审批端口默认拒绝、单一执行路径、回合能力快照、结果按接收顺序输出、`finalizeResult` 单点终结等写成 INV）、`spec/acceptance.test.ts`（从现有测试挑对外承诺的改编号）；`package.json` 的 test 脚本跑验收；`check:agent-arch` 里与门禁重复的规则删，按路径钉文件的防线改成按类名/符号找文件 | `bun run check:module-ownership` 与 `bun run check:gates` 全绿 | 卡片约 300 行；不变量 20–30 条 |
| **8 后续**（与标准正交） | 第 1.5 节 P0 空间知识搬家（会动发请求字节，影响 B3 重放、前缀缓存指纹、`test/fixtures/provider-request-basic.json`，要 agent 与 project 同车发版）；`CodingSessionTracker` 拆出 `SessionToolState`；`Kernel*` 改名；`KernelToolContext` 收成 `AgentToolContext` 并登记 `hostPort`；第 5.3 节提示词修正；工具契约是否独立成包 | 各自一轮，各自差量报告 | — |

### 6.3 风险

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| 并行实例 | 另一个实例正在改 project、`governed-modules.mjs`、`docs/engineering/project-model-guidance-review.json`，还在本次分析期间提交了 agent 的 `LoopRuntime.ts` | agent 改造的每一批只 add 自己的路径；共享文件（登记表、审核指纹、共享脚本）串行改；按既有做法用临时索引加暂存集硬闸，禁用 stash |
| 工作量 | 约 431 次搬家、3,000 处路径、1,000 个声明、810 个接口成员说明、1,485 个函数说明、约 200 处英文、约 150 项可调参数 | 按域分批、每批一个提交、每批跑 6.1 的全绿口径；机械部分全部走脚本（move-files、move-declarations、debarrel） |
| 模型面字节漂移 | 第 4、5 步动说明、schema、提示词 | schema 冻结（`check:agent-schemas`、`check:capabilities-schemas`）、说明预算与结构测试、提示词审核指纹；「数字改引常量」必须字节不变，真正改文案另起提交并点名 |
| 下游破坏 | 第 6 步删入口与 1,659 个无人用的符号、收掉约 190 个被用的零件 | 前五步零破坏；第 6 步是 1.0.0，迁移表逐符号给替代；可以在 1.0 之前先发一版把新面（`createAgentExecutionStack` 等）加上、旧面标弃用，给 Desktop 一个两面并存的窗口 |
| 门禁本身的限制 | 宿主端口写死 `ctx.system`；入口名不能带 `/`；types 不能引 schema | 第 0 步先改门禁，或按本方案绕开（不填 hostPort、入口平铺、类型手写） |
| 按路径钉源码的脚本 | `check-arch-boundaries.mjs` 约 25 个路径、`check-schemas.mjs`、审核脚本 14 个路径 | 第 2 步同提交改；第 7 步改成按符号定位，之后搬家不再碰脚本 |
| 浏览器安全 | `./chat`、`./tool-contract` 的值引用链若带进 `node:fs` 的 utils（`reference-reader.ts`、`jsonl-file.ts`、`skill-frontmatter.ts`…）会在渲染进程炸 | 门禁的 `browserSafeEntries` 检查整条值引用链；Node 专属函数单独成文件，不和渲染要用的混放 |
| 发请求字节与重放 | P0 搬家、驻留账本相关改动 | 放到第 8 步，不和标准化混在一起；搬之前录制 B3 重放基线 |
| 测试结构 | 测试从 `src` 深路径 import 内部件，barrel 与包名自引用 move-files 处理不了 | 第 1 步先 debarrel；之后每步 move-files/move-declarations 会顺带改测试的相对 import |

### 6.4 需要你拍板的项（汇总）

1. 第 3.5 节 8 条：zod 类型手写还是门禁开 schema 例外；可移植文件的写法；工具契约是否独立成包（以及外部桥、产品 Session 服务）；门禁 `hostPortProperty`；入口收成 4 个；1.0.0；P0 搬家放第 8 步；工具面删改。
2. 第 3.1 节产品面：每个接口进不进、名字；尤其 `ExecutionServiceApi` 的 33 个方法按消费方收窄到多少，`CodingSessionTrackerApi` 71 个成员是否等第 8 步拆完再登记。
3. 第 5.2 节：删 `context:distill`，合并 `goal:get`、`plan:get`，删 `tooling:map` 的 `op=read`，`job:cancel` 与 `interrupt` 二选一，`directive:list` 去留，`context:handoff` 接线。
4. 门禁补 `--only/--report` 与 `hostPortProperty`、新增 `debarrel.mjs`（改仓库脚本）。
5. 防线⑤词表扩容（会立刻暴露现存违规，需要先记基线）。

---

## 附录 A：431 个源文件逐个分类

说明：「分类」按第 4.1 节口径；「去处」第一项是第 2 步整文件搬家的目标，其余是第 3–5 步拆出去的去处（例外：`*.tool.ts` 第 2 步先整文件挪到 `impl/builtin/` 暂放，第 5 步合进 `AgentTools.ts`；入口文件在第 1、6 步处理；utils 文件名是缺省名，最终名以第 2.4 节为准）；★ 为新建类；「端口 →」表示该文件里有宿主要实现的接口，进 `contract/requires.ts`。数字按 `7c0bbf8` 统计。

#### `src/agent/`（51 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AgentLoop.ts` | 273 | 混合（函数+类型） | utils/loop/agent-loop.ts<br>types/loop.ts | runAgentLoop 等 6 个函数进 utils/loop/agent-loop.ts；LoopTurnSpans 等类型进 types/loop.ts |
| `AppRuntimeFacts.ts` | 60 | 纯函数 | 删除；AgentHostFacts 进 contract/requires.ts，经执行栈选项注入<br>端口 → contract/requires.ts：AgentHostFacts（原 AppRuntimeFacts） | 模块级可变单例 facts：删除 configureAppRuntimeFacts 全局写入，改为注入面 AgentHostFacts（放进执行栈选项，PromptRegistry 渲染时从 RunContext 取）；AppRuntimeFacts 类型进 contract/requires.ts |
| `CodingSessionTracker.ts` | 1416 | 混合（要拆） | impl/session/CodingSessionTracker.ts<br>utils/session/coding-session-tracker.ts<br>types/session.ts | 1416 行 71 个公开方法、9 类职责；第一阶段整类搬 impl/session/，接口 CodingSessionTrackerApi 写在类上方（= ToolCodingSessionApi ∪ RunnerContextCodingSession）；第二阶段拆出 SessionToolAccess / SessionRunSettings / SessionVerificationTracker / SessionResourceTracker，本类只做门面。DefaultEnabledPromptFeatures 改 private static readonly；数字 1 处 |
| `ContextBuilder.ts` | 454 | 混合（要拆） | impl/runner/ContextBuilder.ts<br>utils/runner/context-builder.ts<br>types/runner.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | ContextBuilder 进 impl/runner/；无状态的 ContextBuilderParts 与单例 contextBuilderHelper 改成 utils/runner/context-builder.ts 的函数；弃用别名 ContextBuilderHelper 删除；数字 1 处 |
| `ContextDegradeLadder.ts` | 72 | 混合（函数+类型） | utils/loop/context-degrade-ladder.ts<br>types/loop.ts |  |
| `ContextPhase.ts` | 70 | 纯函数 | utils/loop/context-phase.ts<br>types/loop.ts |  |
| `ContextUsageCalibrator.ts` | 75 | 类 | impl/context/ContextUsageCalibrator.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 类进 impl/context/；Default/Max/MinCalibrationFactor 三个数字进 utils/tuning.ts（AgentTuning.context.calibration）；数字 6 处 |
| `ExecutionLimits.ts` | 155 | 纯函数 | utils/loop/execution-limits.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | DefaultAgentExecutionLimits 数字进 utils/tuning.ts；MaxNativeTimerDelayMs 属算法数字就地写；resolveAgentExecutionLimits 进 utils/loop/；数字 7 处 |
| `IntentSignals.ts` | 134 | 混合（函数+类型） | utils/loop/intent-signals.ts<br>types/loop.ts |  |
| `LoopContextUsage.ts` | 150 | 混合（要拆） | impl/context/AgentLoopContextUsageManager.ts<br>utils/context/loop-context-usage.ts<br>types/context.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | AgentLoopContextUsageManager 进 impl/context/；resolveModelContextUsageOptions 进 utils/context/；数字 1 处 |
| `LoopRuntime.ts` | 488 | 混合（函数+类型） | utils/loop/loop-runtime.ts<br>types/loop.ts | 8 个子 agent 上下文/工具作用域函数进 utils/loop/loop-runtime.ts；9 个类型进 types/loop.ts；英文文案 1 处 |
| `LoopSurface.ts` | 113 | 混合（要拆） | impl/loop/LoopWindDownGuard.ts<br>utils/loop/loop-surface.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | LoopWindDownGuard 进 impl/loop/；loopContinue/loopFinish 进 utils/loop/；数字 1 处 |
| `PrimaryAgentProfile.ts` | 127 | 混合（要拆） | impl/runner/PrimaryAgentProfile.ts<br>utils/runner/primary-agent-profile.ts<br>types/runner.ts |  |
| `PromptState.ts` | 441 | 混合（要拆） | impl/runner/PromptStateBuilder.ts<br>utils/runner/prompt-state.ts<br>types/runner.ts | PromptStateBuilder 进 impl/runner/（12 个私有方法里 9 个不用 this → utils/runner/prompt-state.ts）；shouldInjectHtmlArtifactPromptForTurn 属 html-artifacts 空间知识，见第一节耦合清单；弃用别名删除 |
| `ProviderTurnRequestHelper.ts` | 511 | 混合（要拆） | impl/loop/ProviderTurnRequestHelper.ts<br>utils/loop/provider-turn-request-helper.ts<br>types/loop.ts | 类进 impl/loop/；11 个类型进 types/loop.ts；buildSystemPromptDelivery 等函数进 utils/loop/ |
| `QueryLoop.ts` | 953 | 混合（要拆） | impl/loop/QueryLoop.ts<br>utils/loop/query-loop.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 类进 impl/loop/（7 个私有方法 4 个不用 this → utils/loop/query-loop.ts）；11 个 QueryLoop* 类型：构造参数类的留在类上方（以类名开头），其余进 types/loop.ts；弃用别名 AgentQueryLoop 删除；数字 3 处 |
| `QueryTurn.ts` | 773 | 混合（要拆） | impl/loop/QueryTurn.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 同 QueryLoop 处理；弃用别名 AgentQueryTurnHelper 删除；数字 2 处 |
| `RoleEngine.ts` | 84 | 类 | impl/runner/AgentRoleEngine.ts |  |
| `RolePolicy.ts` | 69 | 类 | impl/runner/AgentRolePolicy.ts<br>types/runner.ts |  |
| `RoleRegistry.ts` | 43 | 类 | impl/runner/AgentRoleRegistry.ts<br>types/runner.ts<br>端口 → contract/requires.ts：AgentRoleDescriptorProvider |  |
| `RoleRouter.ts` | 43 | 纯函数 | utils/runner/role-router.ts<br>types/runner.ts |  |
| `RoleTypes.ts` | 70 | 类型 | types/runner.ts |  |
| `RunCompletion.ts` | 15 | 纯函数 | utils/loop/run-completion.ts |  |
| `RunLifecycle.ts` | 36 | 类型 | types/runner.ts<br>端口 → contract/requires.ts：AgentRunLifecycle、AgentModelRetryPolicy |  |
| `RunProfile.ts` | 337 | 纯函数 | utils/runner/run-profile.ts<br>types/runner.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | describeRunProfiles 等 const 箭头函数进 utils/runner/run-profile.ts；ToolExposureTierRank 冻结；数字 5 处 |
| `RuntimeConfiguration.ts` | 91 | 类型 | types/runner.ts<br>端口 → contract/requires.ts：AgentExecutionConfig、AgentChatRuntimeConfig、AgentSystemRuntimeConfig |  |
| `RuntimeEvents.ts` | 74 | 纯函数（无状态类改函数） | utils/runner/runtime-events.ts<br>types/runner.ts | 无状态类 AgentRuntimeEvents，外部没有消费方 → 改 utils/runner/runtime-events.ts 的函数 |
| `RuntimeInputPort.ts` | 48 | 混合（函数+类型） | utils/runner/runtime-input-port.ts<br>types/runner.ts<br>端口 → contract/requires.ts：AgentRuntimeInputPort | AgentRuntimeInputPort 进 contract/requires.ts；createAgentRuntimeInputInterruptScope 进 utils/runner/ |
| `RuntimeProfiles.ts` | 200 | 纯函数 | utils/runner/runtime-profiles.ts<br>types/runner.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | RunProfileDefinitions / ToolSurfaceFallbackChains 未冻结 → 冻结后作为规则数据留 utils/runner/runtime-profiles.ts；预算数字进 tuning；数字 8 处 |
| `SessionTelemetryCounters.ts` | 52 | 类 | impl/session/SessionTelemetryCounters.ts |  |
| `SoloBackgroundCompletionGate.ts` | 173 | 混合（函数+类型） | utils/loop/solo-background-completion-gate.ts<br>types/loop.ts |  |
| `SoloContextDegradeActionExecutor.ts` | 118 | 混合（函数+类型） | utils/loop/solo-context-degrade-action-executor.ts<br>types/loop.ts | applySoloContextDegradeAction 进 utils/loop/；它引用的 ContextGovernanceSessionRegistry 改成 types/loop.ts 里的最小形状 GovernanceSessionLookup |
| `SoloFinishingGate.ts` | 327 | 混合（函数+类型） | utils/loop/solo-finishing-gate.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `SoloGoalLifecycle.ts` | 183 | 混合（要拆） | impl/loop/SoloGoalLifecycle.ts<br>utils/loop/solo-goal-lifecycle.ts<br>types/loop.ts | 类进 impl/loop/；3 个工厂函数进 utils/loop/ |
| `SoloLoop.ts` | 1051 | 混合（要拆） | impl/loop/SoloStreamLoop.ts<br>utils/loop/solo-loop.ts<br>types/loop.ts | 类 SoloStreamLoop 进 impl/loop/（check:agent-arch 防线④按路径钉了 SoloLoop.ts 的标记串，搬家同一提交改脚本路径）；弃用别名删除 |
| `SoloLoopTelemetryBuilder.ts` | 180 | 混合（函数+类型） | utils/loop/solo-loop-telemetry-builder.ts<br>types/loop.ts |  |
| `SoloLoopToolExposure.ts` | 68 | 混合（函数+类型） | utils/loop/solo-loop-tool-exposure.ts<br>types/loop.ts |  |
| `SoloModelRequestOptions.ts` | 34 | 纯函数 | utils/loop/solo-model-request-options.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | HtmlArtifactMinimumOutputTokens 是 html-artifacts 空间知识，改由能力注入（见耦合清单）；数字 1 处 |
| `SoloProcessUpdateCadence.ts` | 54 | 混合（函数+类型） | utils/loop/solo-process-update-cadence.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `SoloRunPlanPreparer.ts` | 794 | 混合（函数+类型） | utils/loop/solo-run-plan-preparer.ts<br>types/loop.ts | SkillGateAlwaysKeptToolNames 写死 tooling:* 工具名 → 改引 contract/constants.ts 的 AgentToolNames；check:agent-arch 防线④按路径钉了本文件 |
| `SoloRuntimeGuidance.ts` | 57 | 混合（函数+类型） | utils/loop/solo-runtime-guidance.ts<br>types/loop.ts |  |
| `SoloToolSpaceBootstrapFallback.ts` | 76 | 混合（函数+类型） | utils/loop/solo-tool-space-bootstrap-fallback.ts<br>types/loop.ts |  |
| `SoloToolUseContinuation.ts` | 110 | 混合（函数+类型） | utils/loop/solo-tool-use-continuation.ts<br>types/loop.ts |  |
| `SoloTurnWindDown.ts` | 38 | 纯函数 | utils/loop/solo-turn-wind-down.ts<br>types/loop.ts |  |
| `StreamTurn.ts` | 881 | 混合（要拆） | impl/loop/StreamTurn.ts<br>utils/loop/stream-turn.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 类进 impl/loop/；PromptCacheMinStableSystemChars 等数字进 tuning；弃用别名 AgentStreamTurnHelper 删除；数字 4 处 |
| `TaskApprovalState.ts` | 96 | 类 | impl/session/TaskApprovalState.ts | 类进 impl/session/，接口 TaskApprovalStateApi 写在类上方 |
| `ToolSpaceBootstrapPlanner.ts` | 255 | 混合（函数+类型） | utils/loop/tool-space-bootstrap-planner.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | KernelDiscoveryTools 写死 tooling:map → 引 AgentToolNames；数字 1 处 |
| `TurnCapabilitySnapshot.ts` | 96 | 混合（函数+类型） | utils/loop/turn-capability-snapshot.ts<br>types/loop.ts<br>端口 → contract/requires.ts：AgentTurnCapabilitySnapshotSource | ToolAvailabilityScopes 冻结；函数进 utils/loop/ |
| `TurnRunner.ts` | 189 | 类 | impl/loop/TurnRunner.ts<br>types/loop.ts | 类进 impl/loop/；弃用别名 AgentTurnHelper 删除 |
| `index.ts` | 319 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `retry.ts` | 715 | 混合（要拆） | impl/loop/RetryPolicy.ts<br>utils/model/retry.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | RetryPolicy 进 impl/loop/（19 个私有方法 12 个不用 this → utils/model/retry.ts）；单例 sharedRetryPolicy 改为文件末尾导出的带接口实例；三组错误码 Set 属规则名单留 utils；数字进 tuning；弃用别名 AgentConnectionRetryHelper 删除；英文文案 1 处；数字 6 处 |

#### `src/agent/context/`（18 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ContextLedger.ts` | 103 | 混合（函数+类型） | utils/context/context-ledger.ts<br>types/context.ts |  |
| `ContextPayloadStore.ts` | 157 | 混合（要拆） | impl/context/InMemoryContextPayloadStore.ts<br>utils/context/context-payload-store.ts<br>types/context.ts<br>端口 → contract/requires.ts：ContextPayloadStore | InMemoryContextPayloadStore 进 impl/context/；接口 ContextPayloadStore 是注入面（宿主可换持久实现）→ contract/requires.ts；createContextPayloadRef/UserTextRef 进 utils/context/ |
| `ContextWorkingSetBudgetGovernor.ts` | 240 | 纯函数（无状态类改函数） | utils/context/context-working-set-budget-governor.ts<br>types/context.ts | 只有 3 个公开静态方法的类 → utils/context/working-set-budget.ts 的函数 |
| `ContextWorkingSetOS.ts` | 444 | 纯函数（无状态类改函数） | utils/context/context-working-set-os.ts<br>types/context.ts | 无状态类 → utils/context/working-set.ts 的函数 |
| `ContextWorkingSetZones.ts` | 116 | 类型+常量 | utils/context/context-working-set-zones.ts<br>types/context.ts |  |
| `ProviderRequestCompiler.ts` | 646 | 混合（要拆） | impl/context/ProviderRequestCompiler.ts<br>utils/context/provider-request-compiler.ts<br>types/context.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 类进 impl/context/；7 个模块级函数进 utils/context/provider-request.ts；ProviderSendRequest 的 compileProviderSendRequest 并进本类（方法 compileSendRequest）；数字 2 处 |
| `ProviderRequestSnapshot.ts` | 90 | 混合（函数+类型） | utils/context/provider-request-snapshot.ts<br>types/context.ts |  |
| `ProviderSendRequest.ts` | 170 | 纯函数 | 并入 impl/context/ProviderRequestCompiler.ts（方法 compileSendRequest）<br>types/context.ts | compileProviderSendRequest 用到 UserTextPayloadPlanner 实例 → 并进 ProviderRequestCompiler 类，不进 utils |
| `StatefulToolResults.ts` | 10 | 纯函数 | 删除（死代码） | 死代码：isStatefulToolResultName 恒返回 false → 删文件，ContextWorkingSetOS.ts:189 与 ToolResultCanonicalizer.ts:55 的分支一起删 |
| `ToolPayloadReferencePlanner.ts` | 123 | 纯函数 | impl/context/ToolPayloadReferencePlanner.ts（★） | 函数里 new ToolResultCanonicalizer → 改成 impl/context/ToolPayloadReferencePlanner 类（持有 canonicalizer） |
| `ToolResultCanonicalizer.ts` | 210 | 混合（要拆） | impl/context/ToolResultCanonicalizer.ts<br>utils/context/tool-result-canonicalizer.ts<br>types/context.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 类进 impl/context/；2 处英文报错改中文；英文文案 2 处；数字 1 处 |
| `UserTextPayloadPlanner.ts` | 137 | 混合（要拆） | impl/context/UserTextPayloadPlanner.ts<br>utils/context/user-text-payload-planner.ts<br>types/context.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 类进 impl/context/；OversizedUserTextSafetyValveChars 进 tuning；英文文案 1 处；数字 1 处 |
| `contextBudget.ts` | 113 | 纯函数 | utils/context/context-budget.ts<br>types/context.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 5 个预算数字进 tuning（DefaultContextSafetyMarginPercent 等）；数字 5 处 |
| `contextRefEnvelope.ts` | 184 | 混合（函数+类型） | utils/context/context-ref-envelope.ts<br>types/context.ts |  |
| `contextUsage.ts` | 508 | 混合（函数+类型） | utils/context/context-usage.ts<br>types/context.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 20 个数字常量：ContextUsageHighWatermarkPercent / CompactionPercent 宿主在用 → contract/constants.ts 的 AgentContextThresholds，其余进 tuning；数字 20 处 |
| `index.ts` | 17 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `tokenizer.ts` | 40 | 纯函数 | utils/context/tokenizer.ts<br>types/context.ts | 读 VELAROS_TOKENIZER_ENGINE → 登记到 contract/constants.ts 的 AgentEnvironmentVariables |
| `userMessageText.ts` | 23 | 纯函数 | utils/context/user-message-text.ts |  |

#### `src/agent/context/providerRequest/`（8 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `contentHash.ts` | 16 | 纯函数 | utils/context/content-hash.ts |  |
| `floor.ts` | 197 | 纯函数 | utils/context/floor.ts<br>types/context.ts |  |
| `messageScan.ts` | 149 | 纯函数 | utils/context/message-scan.ts<br>types/context.ts |  |
| `pipeline.ts` | 73 | 混合（函数+类型） | utils/context/pipeline.ts<br>types/context.ts |  |
| `serialization.ts` | 107 | 纯函数 | utils/context/serialization.ts<br>types/context.ts |  |
| `budgetStage.ts` | 213 | 纯函数 | utils/context/budget-stage.ts |  |
| `historySanitizeStage.ts` | 40 | 纯函数 | utils/context/history-sanitize-stage.ts |  |
| `retainedContextStage.ts` | 95 | 纯函数 | utils/context/retained-context-stage.ts<br>types/context.ts |  |

#### `src/agent/context/residency/`（19 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ContextGovernanceSession.ts` | 696 | 混合（要拆） | impl/residency/ContextGovernanceSession.ts<br>impl/residency/ContextGovernanceSessionRegistry.ts<br>utils/residency/context-governance-session.ts<br>types/residency.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 两个类各一个文件进 impl/residency/；模块级 WeakMap fingerprintByMessage 改为 ContextGovernanceSessionRegistry 的实例字段；ContextEpochRequestToolName 进 constants；**模块级可变状态**：fingerprintByMessage；数字 2 处 |
| `ContextRecord.ts` | 186 | 混合（函数+类型） | utils/residency/context-record.ts<br>types/residency.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `GovernanceEpoch.ts` | 758 | 混合（函数+类型） | utils/residency/governance-epoch.ts<br>types/residency.ts | 17 个函数进 utils/residency/governance-epoch.ts；形参里的 ContextResidencyLedger 改成 types/residency.ts 的最小形状 ResidencyLedgerView；数字 3 处 |
| `ResidencyLedger.ts` | 390 | 混合（要拆） | impl/residency/ContextResidencyLedger.ts<br>types/residency.ts | 数字 2 处 |
| `admission.ts` | 576 | 混合（函数+类型） | utils/residency/admission.ts<br>types/residency.ts |  |
| `anchors.ts` | 284 | 纯函数 | utils/residency/anchors.ts<br>types/residency.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | PackageRunnerCommands（bun/npm/pnpm/yarn）、DirectVerificationCommands（pytest/jest/vitest…）是项目空间知识，见耦合清单；数字 2 处 |
| `dashboard.ts` | 191 | 纯函数 | utils/residency/dashboard.ts<br>types/residency.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 3 处 |
| `determinism.ts` | 73 | 纯函数 | utils/residency/determinism.ts |  |
| `distill.ts` | 560 | 混合（函数+类型） | utils/residency/distill.ts<br>types/residency.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 同上：ContextResidencyLedger → ResidencyLedgerView；数字 1 处 |
| `distillRunner.ts` | 195 | 混合（要拆） | impl/residency/ContextDistillRunner.ts<br>utils/residency/distill-runner.ts<br>types/residency.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `governanceConfig.ts` | 581 | 混合（函数+类型） | utils/residency/governance-config.ts<br>types/residency.ts | ContextGovernancePresets / DefaultContextGovernanceConfig 未冻结；宿主在用（Desktop）→ 冻结后进 contract/constants.ts；数字进 tuning；数字 8 处 |
| `governanceWindow.ts` | 93 | 纯函数 | utils/residency/governance-window.ts<br>types/residency.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 2 处 |
| `index.ts` | 32 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `ingest.ts` | 132 | 纯函数 | utils/residency/ingest.ts<br>types/residency.ts | 同上 |
| `messageFacts.ts` | 167 | 纯函数 | utils/residency/message-facts.ts<br>types/residency.ts |  |
| `migrationLog.ts` | 148 | 混合（要拆） | impl/residency/InMemoryContextMigrationEventSink.ts<br>impl/residency/JsonlContextMigrationEventSink.ts<br>utils/residency/migration-log.ts<br>types/residency.ts<br>端口 → contract/requires.ts：ContextMigrationEventSink | 两个 sink 类各一个文件进 impl/residency/；接口 ContextMigrationEventSink 是注入面 → requires |
| `projection.ts` | 522 | 混合（函数+类型） | utils/residency/projection.ts<br>types/residency.ts | 模块级 WeakMap renderedCharsByRecord 改为 ContextResidencyLedger 的实例缓存，投影函数经参数收缓存；**模块级可变状态**：renderedCharsByRecord；数字 2 处 |
| `sessionKey.ts` | 21 | 纯函数 | utils/residency/session-key.ts | check:agent-arch 防线⑦按路径钉「unknown-session 只许出现在这里」→ 搬到 utils/residency/session-key.ts 时同一提交改脚本 |
| `skeleton.ts` | 329 | 混合（函数+类型） | utils/residency/skeleton.ts<br>types/residency.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 3 处 |

#### `src/agent/context/resources/`（6 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `FileContextCoordinator.ts` | 640 | 混合（要拆） | impl/context/FileContextCoordinator.ts<br>impl/context/FileContextRegistry.ts（★ 取代模块级 WeakMap）<br>utils/context/file-context.ts | 模块级 WeakMap coordinators + fileContextFor 工厂 → 新类 impl/context/FileContextRegistry（实例 fileContextRegistry 带接口出包，project 用 .for(carrier)）；FileContextCoordinator 自己进 impl/context/；5 处数字进 tuning；**模块级可变状态**：coordinators；英文文案 2 处；数字 5 处 |
| `FileContextProjection.ts` | 195 | 纯函数 | utils/context/file-context-projection.ts<br>types/context.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 英文文案 3 处；数字 1 处 |
| `FileSnapshotArchive.ts` | 205 | 纯函数 | utils/context/file-snapshot-archive.ts<br>types/context.ts | FileSnapshotToolName 等内部工具名进 constants；5 处英文报错；英文文案 5 处 |
| `PrivateFileRecords.ts` | 10 | 纯函数 | utils/context/private-file-records.ts | 写死 __project_file_reference__ 等 project 私有记录名 → 改由能力注入（见耦合清单） |
| `contracts.ts` | 88 | 类型 | types/context.ts | FileContext* 9 个类型：project 在用 → types/context.ts 并随 ./tool-contract 出包 |
| `index.ts` | 4 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/agent/context/retrieval/`（14 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `BoundedRecentMap.ts` | 71 | 混合（要拆） | impl/retrieval/ContextRetrievalBoundedRecentMap.ts<br>impl/retrieval/ContextRetrievalBoundedCounter.ts | 两个类各一个文件进 impl/retrieval/ |
| `ContextRetrievalService.ts` | 1351 | 混合（要拆） | impl/retrieval/ChatContextRetrievalService.ts<br>types/retrieval.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 1351 行，类进 impl/retrieval/（24 个私有方法 6 个不用 this → utils/retrieval/）；数字 4 处 |
| `IndexBuilder.ts` | 122 | 类 | impl/retrieval/ContextRetrievalIndexBuilder.ts |  |
| `IndexSnapshot.ts` | 151 | 混合（函数+类型） | utils/retrieval/index-snapshot.ts<br>types/retrieval.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `Pagination.ts` | 165 | 纯函数 | utils/retrieval/pagination.ts<br>types/retrieval.ts |  |
| `PayloadReader.ts` | 774 | 混合（要拆） | impl/retrieval/ContextRetrievalPayloadReader.ts<br>utils/retrieval/payload-reader.ts<br>types/retrieval.ts | 英文文案 3 处 |
| `QueryTraceStore.ts` | 173 | 类 | impl/retrieval/ContextRetrievalQueryTraceStore.ts<br>types/retrieval.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 2 处 |
| `ReferenceReader.ts` | 377 | 纯函数（无状态类改函数） | utils/retrieval/reference-reader.ts | 只有常量字段 → utils/retrieval/（读盘函数带 node:fs，确保不进浏览器入口） |
| `References.ts` | 410 | 纯函数（无状态类改函数） | utils/retrieval/references.ts<br>types/retrieval.ts | 只有常量字段的单例类 → utils/retrieval/references.ts 的函数，maxReferencedLogs 等进 tuning |
| `index.ts` | 13 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `Messages.ts` | 127 | 纯函数（无状态类改函数） | utils/retrieval/messages.ts<br>types/retrieval.ts | 常量字段单例 chatSearchMessages → utils/retrieval/search-messages.ts；search/ 子目录并回 utils/retrieval/ |
| `Ranking.ts` | 496 | 纯函数（无状态类改函数） | utils/retrieval/ranking.ts<br>types/retrieval.ts | 常量字段单例 chatSearchRanking（Desktop 在用）→ 函数进 utils/retrieval/search-ranking.ts，公开面由 ChatContextRetrievalServiceApi 暴露排序方法；PathHintExtensions 属规则名单 |
| `Text.ts` | 84 | 纯函数（无状态类改函数） | utils/retrieval/text.ts | 常量字段单例 → utils/retrieval/search-text.ts，数字进 tuning |
| `sessionStorePorts.ts` | 41 | 类型 | types/retrieval.ts<br>端口 → contract/requires.ts：RetrievalPayloadStorePort、RetrievalStateStorePort |  |

#### `src/agent/control-plane/`（7 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AgentRunPlan.ts` | 123 | 类型 | types/loop.ts |  |
| `AgentRunPlanLedger.ts` | 32 | 类 | impl/loop/AgentRunPlanLedgerFactory.ts | 有递增 id 的类进 impl/loop/；单例 agentRunPlanLedgerFactory 改为文件末尾带接口实例 |
| `AgentRunPlanner.ts` | 239 | 纯函数（无状态类改函数） | utils/loop/agent-run-planner.ts<br>types/loop.ts | 三个无状态类 + 三个单例 → utils/loop/run-planner.ts 的函数 |
| `CapabilityRunPlanner.ts` | 400 | 纯函数（无状态类改函数） | utils/loop/capability-run-planner.ts<br>types/loop.ts | 无状态类 + 单例 → utils/loop/capability-run-planner.ts |
| `RuntimeRunPlanner.ts` | 277 | 纯函数（无状态类改函数） | utils/loop/runtime-run-planner.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 三个无状态类 + 单例 → utils/loop/runtime-run-planner.ts；数字 1 处 |
| `SessionToolAllocator.ts` | 368 | 混合（要拆） | impl/tools/SessionToolAllocator.ts<br>utils/tools/session-tool-allocator.ts<br>types/tools.ts | 类进 impl/tools/；模块级单例 sessionToolAllocator 带可变 Map（跨会话共享）且无人使用 → 删除；阈值 3 进 tuning；数字 1 处 |
| `index.ts` | 58 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/agent/history/`（9 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `contextOSMessage.ts` | 189 | 纯函数 | utils/history/context-os-message.ts<br>types/history.ts |  |
| `index.ts` | 66 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `internalMessages.ts` | 74 | 纯函数 | utils/history/internal-messages.ts<br>types/history.ts |  |
| `messages.ts` | 116 | 纯函数（无状态类改函数） | utils/history/messages.ts<br>types/history.ts | 无状态类 HistoryMessages（+ repair.ts 里的单例 messageHelper）→ utils/history/messages.ts 的函数；弃用别名删除 |
| `repair.ts` | 250 | 混合（函数+类型） | utils/history/repair.ts<br>types/history.ts |  |
| `request.ts` | 51 | 纯函数 | utils/history/request.ts<br>types/history.ts |  |
| `sanitize.ts` | 1230 | 混合（函数+类型） | utils/history/sanitize.ts<br>types/history.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 1230 行 59 个函数，整文件进 utils/history/sanitize.ts（不拆）；数字 1 处 |
| `turn.ts` | 206 | 纯函数（无状态类改函数） | utils/history/turn.ts<br>types/history.ts | 无状态类 ToolResults / TurnHistory → utils/history/turn.ts；TurnHistory 被 project 测试与 Desktop 用 → 公开面给 TurnHistoryApi 实例（或把用法并进 ProviderRequestCompilerApi）；别名 AgentToolResultHelper/AgentTurnHistoryHelper/ToolResults 删除 |
| `validate.ts` | 296 | 混合（函数+类型） | utils/history/validate.ts<br>types/history.ts |  |

#### `src/agent/model/`（7 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AgentModelRequest.ts` | 135 | 混合（要拆） | impl/loop/AiSdkAgentModelRequestPort.ts<br>utils/model/agent-model-request.ts<br>types/loop.ts | AiSdkAgentModelRequestPort 进 impl/loop/；AgentModelRequestPort 接口在类上方 |
| `ModelContracts.ts` | 53 | 类型 | types/loop.ts<br>端口 → contract/requires.ts：AgentModelResolverPort、AgentModelProvider、AgentModelRequestOptions、AgentModelRequestPolicy | AgentModelResolverPort / AgentModelProvider / AgentModelRequestOptions 是注入面 → contract/requires.ts |
| `ModelInputCompatibility.ts` | 86 | 纯函数 | utils/model/model-input-compatibility.ts |  |
| `ModelRequestError.ts` | 88 | 纯函数 | utils/model/model-request-error.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `PromptCache.ts` | 208 | 纯函数 | utils/model/prompt-cache.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 9 个常量含 provider 缓存提示键，见耦合清单（厂商知识）；数字进 tuning；数字 3 处 |
| `RequestAbortScope.ts` | 35 | 需改类（闭包/对象字面量） | impl/loop/LinkedAbortScope.ts（★） | 闭包工厂 createLinkedAbortScope 返回带方法对象 → 改成 impl/loop/LinkedAbortScope 类（或保留为 utils 函数返回纯数据 + 独立 dispose 函数） |
| `index.ts` | 5 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/agent/run-context/`（6 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `RunContext.ts` | 305 | 类 | impl/runner/RunContext.ts<br>types/runner.ts | 类进 impl/runner/；登记在 project 的提示词审核指纹里（docs/engineering/project-model-guidance-review.json），搬家同一提交重算 |
| `TurnContextFormat.ts` | 84 | 纯函数 | utils/runner/turn-context-format.ts<br>types/runner.ts |  |
| `TurnContextLedger.ts` | 249 | 混合（要拆） | impl/records/TurnContextLedger.ts<br>impl/records/TurnContextAppendHub.ts<br>impl/records/TurnContextSessionLedgers.ts<br>utils/records/turn-context-ledger.ts<br>types/records.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 三个类各一个文件进 impl/records/；模块级 let ledgerInstanceSeq 改为 TurnContextSessionLedgers 的实例计数；browser、memory 包在用 → 公开面 TurnContextSessionLedgersApi；**模块级可变状态**：let ledgerInstanceSeq；数字 2 处 |
| `TurnPayload.ts` | 186 | 纯函数（无状态类改函数） | utils/runner/turn-payload.ts<br>types/runner.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 无状态类 → utils/runner/turn-payload.ts；别名 AgentTurnContextPayloadBuilder 删除；数字 2 处 |
| `host-ports.ts` | 42 | 类型 | types/runner.ts | RunContextCodingSession / RunContextToolContext → types/runner.ts（内部），宿主要实现的部分并进 requires 的 AgentToolContext |
| `index.ts` | 10 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/agent/runner/`（11 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AgentExecutionStack.ts` | 197 | 需改类（闭包/对象字面量） | impl/assembly/AgentExecutionStack.ts（★ 类 + 工厂 createAgentExecutionStack）<br>types/runner.ts | 闭包工厂 → impl/assembly/AgentExecutionStack 类 + 模块级工厂 createAgentExecutionStack（入口唯一的值），接口 AgentExecutionStackApi 在类上方并在 provides 登记 |
| `AgentRunner.ts` | 475 | 类 | impl/runner/AgentRunner.ts<br>types/runner.ts | 类进 impl/runner/；passthroughExecutionEnvironment 对象字面量改 private static readonly；2 处英文；英文文案 2 处 |
| `AgentRunnerTypes.ts` | 39 | 类型 | types/runner.ts | AgentRunnerInfrastructure 改名 AgentRunnerOptions，作为「以类名开头的配套接口」写进 impl/runner/AgentRunner.ts（它引用 QueryLoop、SoloStreamLoop 的接口，types/ 引不到） |
| `AgentSurfaceProfile.ts` | 64 | 类型 | types/runner.ts<br>端口 → contract/requires.ts：AgentSurfaceProfileProvider |  |
| `AgentWorkflowCoordinator.ts` | 134 | 类 | impl/runner/AgentWorkflowCoordinator.ts<br>types/runner.ts |  |
| `GoalLifecycleProjection.ts` | 227 | 混合（函数+类型） | utils/runner/goal-lifecycle-projection.ts<br>types/runner.ts | 纯函数进 utils/runner/goal-lifecycle-projection.ts；Desktop、Workbench 在用 → 经 ./chat 的 agentChat 实例出包 |
| `ModelRuntime.ts` | 70 | 类 | impl/runner/ModelRuntime.ts | 类进 impl/runner/；别名 AgentRuntimeHelper 删除 |
| `codingTracking.ts` | 33 | 纯函数 | utils/runner/coding-tracking.ts |  |
| `goalLifecycle.ts` | 31 | 纯函数 | utils/runner/goal-lifecycle.ts |  |
| `host-ports.ts` | 188 | 类型 | types/runner.ts<br>端口 → contract/requires.ts：RunnerExecutionEnvironmentPort、RunnerConfigService、RunnerToolContextBuilder、RunnerSubAgentDispatcher、RunnerModelRuntimePort、RunnerToolRegistry | 19 个类型：宿主实现的端口（RunnerExecutionEnvironmentPort、RunnerConfigService、RunnerToolContextBuilder、RunnerSubAgentDispatcher、RunnerModelRuntimePort…）→ contract/requires.ts；其余 → types/runner.ts；ExecutionEventBus 类型引用改 ExecutionEventBusApi（provides 登记） |
| `index.ts` | 33 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/agent/stream/`（14 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `Consumer.ts` | 1126 | 混合（要拆） | impl/loop/StreamConsumer.ts<br>utils/stream/consumer.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | StreamConsumer 进 impl/loop/；别名 AgentStreamConsumerHelper 删除；数字 1 处 |
| `EmptyStreamRecovery.ts` | 123 | 纯函数 | utils/stream/empty-stream-recovery.ts<br>types/loop.ts |  |
| `OutputTruncationRecovery.ts` | 63 | 纯函数 | utils/stream/output-truncation-recovery.ts<br>types/loop.ts |  |
| `diagnostics.ts` | 59 | 类 | impl/loop/StreamDiagnosticsHelper.ts | StreamDiagnosticsHelper（持 log）进 impl/loop/；别名删除 |
| `generated-artifacts.ts` | 54 | 纯函数 | utils/stream/generated-artifacts.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `idle-read.ts` | 105 | 纯函数 | utils/stream/idle-read.ts<br>types/loop.ts |  |
| `index.ts` | 85 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `inline-reasoning-tags.ts` | 149 | 混合（函数+类型） | utils/stream/inline-reasoning-tags.ts<br>types/loop.ts | Desktop 在用 → 经 ./chat 的 agentChat 实例出包（split/flush） |
| `leaked-tool-markup.ts` | 78 | 纯函数 | utils/stream/leaked-tool-markup.ts<br>types/loop.ts |  |
| `raw-text.ts` | 208 | 纯函数（无状态类改函数） | utils/stream/raw-text.ts | 无状态类 → utils/stream/raw-text.ts |
| `recorder.ts` | 455 | 纯函数（无状态类改函数） | utils/stream/recorder.ts<br>types/loop.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 无状态类 StreamDiagnosticRecorder → utils/stream/recorder.ts；未冻结的 finish reason 表冻结；数字 1 处 |
| `tool-call-id.ts` | 20 | 纯函数 | utils/stream/tool-call-id.ts |  |
| `tool-input.ts` | 544 | 混合（函数+类型） | utils/stream/tool-input.ts<br>types/loop.ts |  |
| `types.ts` | 64 | 类型 | types/loop.ts |  |

#### `src/bridge/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ExternalAgentBridgeLoopbackServer.ts` | 140 | 混合（要拆） | impl/connectors/ExternalAgentBridgeLoopbackServer.ts<br>utils/connectors/external-agent-bridge-loopback-server.ts<br>types/connectors.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 类进 impl/connectors/；Host/Port 常量进 contract/constants.ts（ExternalAgentBridgeLimits）；3 处英文；英文文案 3 处；数字 3 处 |
| `ExternalAgentBridgeState.ts` | 99 | 混合（要拆） | impl/connectors/ExternalAgentBridgeCommandQueue.ts<br>impl/connectors/ExternalAgentBridgeEventWindow.ts<br>impl/connectors/ExternalAgentBridgePairingThrottle.ts<br>utils/connectors/external-agent-bridge-state.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 三个类各一个文件进 impl/connectors/；5 个上限里 ExternalAgentBridgePairingLifetimeMs 宿主在用（Desktop、Termel）→ constants，其余 4 个进 tuning；英文文案 1 处；数字 5 处 |
| `index.ts` | 21 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/capabilities/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `CapabilityExtensions.ts` | 433 | 混合（函数+类型） | utils/capabilities.ts<br>types/capabilities.ts<br>端口 → contract/requires.ts：AgentRuntimeCapabilityPorts 及 ToolResultMiddleware、ToolValidationHintProvider、CapabilityPromptContributor、CapabilityContextCollector、CapabilityIntentClassifier、CapabilityValidationInterpreter、CapabilityScopePolicy、CapabilityDelegationPolicy | 26 个扩展接口是注入面核心 → contract/requires.ts（AgentRuntimeCapabilityPorts 及其成员接口）；17 个 resolve* 函数进 utils/capabilities.ts（utils 根，文件数不够开子目录）；英文文案 2 处 |
| `CapabilityValidation.ts` | 35 | 类型 | types/capabilities.ts | 6 个验证结果类型 → types/capabilities.ts（requires 用到的出包） |
| `index.ts` | 55 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/chat/`（6 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `index.ts` | 20 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `messages.ts` | 213 | 纯函数（无状态类改函数） | impl/chat/ChatMessages.ts（公开实例 chatMessages）<br>utils/chat/messages.ts | 无状态类 ChatMessages（Desktop 在用）→ 保留类 + 实例 chatMessages 带 ChatMessagesApi 出包 ./chat，私有方法进 utils/chat/；英文文案 1 处 |
| `resolveChatSendRequest.ts` | 82 | 纯函数 | utils/chat/resolve-chat-send-request.ts<br>types/chat.ts |  |
| `resolveStoredChatSession.ts` | 66 | 纯函数 | utils/chat/resolve-stored-chat-session.ts |  |
| `sessionLineage.ts` | 31 | 纯函数 | utils/chat/session-lineage.ts |  |
| `sessionSearchText.ts` | 17 | 纯函数 | utils/chat/session-search-text.ts | 数字 1 处 |

#### `src/chat/stream/`（5 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ChatStreamConsumer.ts` | 123 | 类 | impl/chat/ChatStreamConsumer.ts |  |
| `ChatStreamProtocol.ts` | 301 | 类 | impl/chat/ChatStreamProtocol.ts（公开实例 chatStreamProtocol）<br>utils/chat/stream-protocol.ts | 常量字段单例 chatStreamProtocol（Desktop 8 处）→ 保留类 + 实例带 ChatStreamProtocolApi 出包 ./chat；chat/stream 并进 impl/chat/；英文文案 1 处 |
| `ChatStreamSessionLog.ts` | 109 | 类 | impl/chat/ChatStreamSessionLog.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `index.ts` | 13 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `types.ts` | 27 | 类型 | types/chat.ts |  |

#### `src/coding/`（6 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AutoVerification.ts` | 243 | 混合（函数+类型） | utils/session/auto-verification.ts<br>types/session.ts | tickLoopReminders 等进 utils/session/auto-verification.ts |
| `edit-results.ts` | 78 | 类 | impl/session/CodingSessionEditResultHelper.ts |  |
| `index.ts` | 24 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `paths.ts` | 105 | 纯函数 | utils/session/paths.ts | CodeVerificationExtensions / CodeVerificationFilenames 是项目空间知识，见耦合清单 |
| `tool-dedupe.ts` | 105 | 混合（要拆） | impl/session/CodingToolCallDeduper.ts<br>utils/session/tool-dedupe.ts | IDEMPOTENT_TOOL_CALLS 写死 tooling:* 名 → 引 AgentToolNames |
| `verification.ts` | 77 | 类 | impl/session/CodingSessionVerificationHelper.ts<br>types/session.ts |  |

#### `src/execution-modes/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ExecutionModeDescriptor.ts` | 47 | 类型 | types/runner.ts |  |
| `ExecutionModeRegistry.ts` | 160 | 纯函数 | utils/runner/execution-mode-registry.ts |  |
| `index.ts` | 19 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/execution/`（17 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ExecutionIdFactory.ts` | 58 | 类 | impl/records/MonotonicExecutionIdFactory.ts<br>types/records.ts<br>端口 → contract/requires.ts：ExecutionClock、ExecutionIdFactory | 英文文案 1 处 |
| `GuidanceQueue.ts` | 158 | 混合（要拆） | impl/records/ExecutionGuidanceQueue.ts<br>utils/records/guidance-queue.ts<br>types/records.ts |  |
| `GuidanceRelayPlanner.ts` | 278 | 混合（函数+类型） | utils/records/guidance-relay.ts<br>impl/records/GuidanceRelayKit.ts（★ 公开实例 guidanceRelay）<br>types/records.ts |  |
| `Interactions.ts` | 279 | 混合（要拆） | impl/records/ExecutionInteractions.ts<br>utils/records/interactions.ts<br>types/records.ts |  |
| `Records.ts` | 564 | 混合（要拆） | impl/records/ExecutionRecords.ts<br>utils/records/records.ts<br>types/records.ts | ExecutionRecords 进 impl/records/；无状态 ExecutionRecordSummaryHelper → utils/records/；英文文案 1 处 |
| `SessionGuard.ts` | 103 | 类 | impl/records/SourceSessionGuard.ts<br>types/records.ts |  |
| `Store.ts` | 848 | 混合（要拆） | impl/records/ExecutionStore.ts<br>utils/records/store.ts<br>types/records.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | ExecutionStore 进 impl/records/（41 个私有方法 9 个不用 this → utils/records/）；无状态 ExecDebugPayload → utils；三个状态 Set 属规则名单；6 处英文报错；英文文案 6 处；数字 3 处 |
| `SubAgentGuidanceRelayRegistry.ts` | 136 | 混合（要拆） | impl/records/SubAgentGuidanceRelayRegistry.ts<br>types/records.ts |  |
| `agent-events.ts` | 209 | 混合（要拆） | impl/records/ExecAgentEvents.ts<br>utils/records/agent-events.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `index.ts` | 80 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 | 入口：14 对「新名/旧名」别名（ExecStore/ExecutionStore…）全部删除 |
| `plan-ledger.ts` | 215 | 类 | impl/records/ExecPlanLedger.ts<br>types/records.ts |  |
| `plan-state.ts` | 174 | 纯函数（无状态类改函数） | utils/records/plan-state.ts | 无状态类 → utils/records/plan-state.ts；Workbench 在用 ExecPlanState → 公开面并进 ExecutionServiceApi 或给实例 |
| `routing-types.ts` | 20 | 类型 | types/records.ts |  |
| `routing.ts` | 105 | 混合（要拆） | impl/records/ExecWorkflowRoute.ts<br>impl/records/ExecRouting.ts<br>utils/records/routing.ts<br>types/records.ts | ExecRouting、ExecWorkflowRoute 各一个文件进 impl/records/；resolveTurnRouteIdentity 进 utils |
| `state-machine.ts` | 46 | 纯函数（无状态类改函数） | utils/records/state-machine.ts | 无状态类 + AllowedTransitions 表 → utils/records/state-machine.ts（表冻结，属规则数据） |
| `store-types.ts` | 36 | 类型 | types/records.ts |  |
| `task-ledger.ts` | 279 | 混合（要拆） | impl/records/ExecTaskLedger.ts<br>utils/records/task-ledger.ts | ExecTaskLedger 进 impl/records/；无状态 ExecRecordSeverity → utils |

#### `src/host/`（1 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `index.ts` | 44 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/`（2 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `index.ts` | 20 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `kernel-module.ts` | 176 | 需改类（闭包/对象字面量） | impl/assembly/AgentKernelModule.ts（★ 类 + 工厂 createAgentKernelModule）<br>contract/constants.ts（AgentIdentity）<br>端口 → contract/requires.ts：AgentCapabilityRuntime、CreateAgentKernelModuleOptions | 闭包工厂 → impl/assembly/AgentKernelModule 类 + 工厂 createAgentKernelModule；AgentKernelModuleId、AgentExecutionPermission 进 constants；AgentCapability 令牌是值 → 文件末尾带类型实例；3 处英文；英文文案 3 处 |

#### `src/kernel/`（14 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AgentCapabilityEventPublisher.ts` | 65 | 类 | impl/execution/AgentCapabilityEventPublisher.ts<br>types/execution.ts |  |
| `background-jobs.ts` | 1053 | 混合（要拆） | impl/records/KernelBackgroundJobManager.ts<br>impl/records/InMemoryKernelBackgroundJobOutputStore.ts<br>utils/records/background-jobs.ts<br>types/records.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts<br>端口 → contract/requires.ts：KernelBackgroundJobOutputStore | KernelBackgroundJobManager、InMemoryKernelBackgroundJobOutputStore 各一个文件进 impl/records/；12 个函数进 utils/records/background-jobs.ts；7 处英文报错；类名去掉 Kernel 前缀（与 @velaros-ai/kernel 同名异义）列为可选改名；英文文案 7 处；数字 4 处 |
| `context-epoch.ts` | 196 | 混合（要拆） | impl/loop/KernelContextEpochGuard.ts<br>impl/errors/KernelContextEpochStaleError.ts<br>utils/loop/context-epoch.ts<br>types/loop.ts | KernelContextEpochGuard 进 impl/loop/；KernelContextEpochStaleError 进 impl/errors/，code 进 AgentErrorCodes；函数形参里的 ProviderTurnEventReducer 改最小形状；英文文案 2 处 |
| `controller.ts` | 111 | 混合（要拆） | impl/assembly/KernelSessionController.ts<br>types/execution.ts | KernelSessionController 进 impl/assembly/ |
| `final-readiness.ts` | 109 | 混合（函数+类型） | utils/loop/final-readiness.ts<br>types/loop.ts |  |
| `index.ts` | 19 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `jsonl-file.ts` | 116 | 纯函数 | utils/ledgers/jsonl-file.ts<br>types/ledgers.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 函数进 utils/ledgers/jsonl-file.ts（含 node:fs，只进 Node 入口）；英文文案 1 处；数字 1 处 |
| `policy.ts` | 51 | 纯函数（无状态类改函数） | utils/execution/session-policy.ts<br>types/execution.ts | 无状态类 KernelSessionPolicy → utils/execution/session-policy.ts |
| `prefix-shape.ts` | 231 | 混合（要拆） | impl/loop/KernelPrefixShapeTracker.ts<br>utils/loop/prefix-shape.ts<br>types/loop.ts | KernelPrefixShapeTracker 进 impl/loop/；函数进 utils/loop/；英文文案 2 处 |
| `provider-events.ts` | 419 | 混合（要拆） | impl/records/ProviderTurnEventReducer.ts<br>utils/records/provider-events.ts<br>types/records.ts | ProviderTurnEventReducer 进 impl/records/（Executor 与 StreamConsumer 都要引，放低层）；7 处英文报错；英文文案 7 处 |
| `session-lane.ts` | 694 | 混合（要拆） | impl/execution/KernelSessionRunCoordinator.ts<br>impl/execution/InMemoryKernelSessionInputStore.ts<br>impl/execution/PersistentKernelSessionInputStore.ts<br>impl/errors/KernelSessionRunInterruptedError.ts<br>utils/execution/session-lane.ts<br>types/execution.ts<br>端口 → contract/requires.ts：KernelSessionInputStore | 三个类 + 一个错误类各一个文件：impl/execution/KernelSessionRunCoordinator.ts、InMemoryKernelSessionInputStore.ts、PersistentKernelSessionInputStore.ts、impl/errors/KernelSessionRunInterruptedError.ts；KernelSessionInputStore 接口 → requires；6 处英文；英文文案 6 处 |
| `tool-loop-guard.ts` | 121 | 混合（要拆） | impl/tools/KernelToolLoopGuard.ts<br>utils/tools/tool-loop-guard.ts<br>types/tools.ts |  |
| `tool-materialization.ts` | 63 | 类 | impl/tools/KernelToolResultMaterializer.ts<br>types/tools.ts |  |
| `tool-output-store.ts` | 348 | 混合（要拆） | impl/tools/InMemoryKernelToolOutputStore.ts<br>impl/tools/ContextPayloadKernelToolOutputStore.ts<br>utils/tools/tool-output-store.ts<br>types/tools.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts<br>端口 → contract/requires.ts：KernelToolOutputStore | 两个类各一个文件进 impl/tools/；KernelToolOutputStore 接口 → requires；数字 1 处 |

#### `src/kernel/bridge/`（2 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ChatKernelSessionBridge.ts` | 642 | 混合（要拆） | impl/assembly/ChatKernelSessionBridge.ts<br>utils/execution/chat-kernel-session-bridge.ts<br>types/execution.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 类进 impl/assembly/；4 处英文；英文文案 4 处；数字 1 处 |
| `index.ts` | 9 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/kernel/dispatch/`（8 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `SubAgentDispatcher.ts` | 1840 | 混合（要拆） | impl/delegation/SubAgentDispatcher.ts<br>utils/delegation/sub-agent-dispatcher.ts<br>types/delegation.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 1840 行，类进 impl/delegation/（49 个私有方法 14 个不用 this → utils/delegation/）；check:agent-arch 按路径钉了本文件；数字 4 处 |
| `SubAgentProgressDigest.ts` | 81 | 混合（要拆） | impl/delegation/SubAgentProgressDigestRecorder.ts<br>utils/delegation/sub-agent-progress-digest.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `SubAgentProgressLedger.ts` | 171 | 混合（要拆） | impl/delegation/SubAgentProgressLedger.ts<br>utils/delegation/sub-agent-progress-ledger.ts<br>types/delegation.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 5 处 |
| `concurrency.ts` | 76 | 类 | impl/delegation/Semaphore.ts<br>types/delegation.ts | Semaphore 改名 SubAgentDispatchSemaphore 进 impl/delegation/ |
| `host-ports.ts` | 111 | 类型 | types/delegation.ts<br>端口 → contract/requires.ts：SubAgentConfigPort、SubAgentQueryRunner、CustomSubAgentRegistry | SubAgentConfigPort / SubAgentQueryRunner / CustomSubAgentRegistry → requires；SubAgentDispatchInput 等数据 → types/delegation.ts |
| `index.ts` | 8 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `instruction.ts` | 129 | 纯函数 | utils/delegation/instruction.ts<br>types/delegation.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `result-format.ts` | 162 | 纯函数 | utils/delegation/result-format.ts<br>types/delegation.ts |  |

#### `src/kernel/execution/`（12 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ExecutionAgentEventFacade.ts` | 92 | 类 | impl/execution/ExecutionAgentEventFacade.ts<br>types/execution.ts |  |
| `ExecutionEventBus.ts` | 366 | 混合（要拆） | impl/records/ExecutionEventBus.ts<br>utils/records/execution-event-bus.ts<br>types/records.ts | 类进 impl/records/（被多层引用，放低层）；公开静态成员 1 个改成模块级工厂或实例方法；Desktop 8、Workbench 16 处 → 公开面 ExecutionEventBusApi + createExecutionEventBus |
| `ExecutionInteractionFacade.ts` | 199 | 类 | impl/execution/ExecutionInteractionFacade.ts |  |
| `ExecutionService.ts` | 673 | 类 | impl/execution/ExecutionService.ts<br>types/execution.ts |  |
| `ExecutionStateFacade.ts` | 65 | 类 | impl/execution/ExecutionStateFacade.ts<br>types/execution.ts |  |
| `ExecutionTaskFacade.ts` | 62 | 类 | impl/execution/ExecutionTaskFacade.ts |  |
| `ManagedExecutionRunner.ts` | 341 | 混合（要拆） | impl/execution/ManagedExecutionRunner.ts<br>utils/execution/managed-execution-runner.ts<br>types/execution.ts | 英文文案 1 处 |
| `SoloExecutionService.ts` | 133 | 混合（要拆） | impl/execution/SoloExecutionService.ts<br>utils/execution/solo-execution-service.ts<br>types/execution.ts |  |
| `ToolExecutionApiFactory.ts` | 66 | 需改类（闭包/对象字面量） | impl/tools/ToolExecutionApiBinding.ts（★） | 闭包工厂 → utils/execution/tool-execution-api.ts 纯函数（返回的对象只闭包 host，不存状态）或 impl/execution/ToolExecutionApiBinding 类 |
| `confirmation-tool.ts` | 77 | 需改类（闭包/对象字面量） | impl/AgentTools.ts（interaction:confirm，改用 defineVelaTool） | interaction:confirm 工具的对象字面量定义 → 改用 defineVelaTool 收进 impl/AgentTools.ts |
| `host-ports.ts` | 95 | 类型 | types/execution.ts<br>端口 → contract/requires.ts：AuthGatePort、ExecutionRecordsPathPort、ExecutionResourcePort、ExecutionActivitySignalsPort、ExecutionCollaborationPort、ExecutionGuidanceRelayPlanner | AuthGatePort / ExecutionRecordsPathPort / ExecutionResourcePort / ExecutionActivitySignalsPort / ExecutionCollaborationPort / ExecutionGuidanceRelayPlanner → contract/requires.ts |
| `index.ts` | 12 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/kernel/observability/`（8 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ExecutionSpanLedger.ts` | 100 | 类 | impl/ledgers/ExecutionSpanLedger.ts<br>types/ledgers.ts | 英文文案 2 处 |
| `ExecutionSpanRecorder.ts` | 124 | 混合（要拆） | impl/ledgers/OpenExecutionSpan.ts<br>impl/ledgers/ExecutionSpanRecorder.ts<br>types/ledgers.ts | OpenExecutionSpan、ExecutionSpanRecorder 各一个文件进 impl/ledgers/；英文文案 1 处 |
| `execution-ledger-file.ts` | 63 | 纯函数 | utils/ledgers/execution-ledger-file.ts<br>types/ledgers.ts |  |
| `execution-span-debug.ts` | 306 | 混合（函数+类型） | utils/ledgers/execution-span-debug.ts<br>types/ledgers.ts |  |
| `execution-span-scope.ts` | 579 | 混合（要拆） | impl/ledgers/LedgerExecutionSpanScopeFactory.ts<br>impl/ledgers/LedgerRunSpanScope.ts<br>impl/ledgers/LedgerTurnSpanScope.ts<br>utils/ledgers/execution-span-scope.ts<br>types/ledgers.ts<br>端口 → contract/requires.ts：ExecutionSpanScopeFactory（可选注入） | 三个类各一个文件进 impl/ledgers/；NOOP_TOOL_OPENER 对象字面量改带类型实例；check:agent-arch 防线⑤钉了路径与标记串；英文文案 1 处 |
| `execution-span-tree.ts` | 84 | 纯函数 | utils/ledgers/execution-span-tree.ts<br>types/ledgers.ts |  |
| `index.ts` | 92 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `prompt-audit.ts` | 182 | 混合（要拆） | impl/ledgers/PromptAuditLedger.ts<br>utils/ledgers/prompt-audit.ts<br>types/ledgers.ts | 英文文案 2 处 |

#### `src/kernel/session-store/`（6 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `SessionLedger.ts` | 295 | 混合（要拆） | impl/ledgers/SessionStore.ts<br>impl/ledgers/SessionLedger.ts<br>types/ledgers.ts | SessionStore、SessionLedger 各一个文件进 impl/ledgers/；公开静态成员改工厂；7 处英文报错；英文文案 7 处 |
| `index.ts` | 31 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `ledger-file.ts` | 96 | 纯函数 | utils/ledgers/ledger-file.ts<br>types/ledgers.ts |  |
| `ports.ts` | 43 | 类型 | types/ledgers.ts<br>端口 → contract/requires.ts：SessionLedgerLocator、SessionStoreDeps |  |
| `session-tree.ts` | 170 | 混合（函数+类型） | utils/ledgers/session-tree.ts<br>types/ledgers.ts |  |
| `write-queue.ts` | 28 | 类 | impl/ledgers/SerialWriteQueue.ts |  |

#### `src/mods/`（8 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AgentModHostAssembly.ts` | 222 | 混合（函数+类型） | impl/assembly/AgentModHostAssembler.ts（★）<br>types/mods.ts<br>端口 → contract/requires.ts：AgentModPackReader | assembleAgentMods 函数里 new AgentModLoader → impl/assembly/AgentModHostAssembler 类 + 工厂 |
| `AgentModLoader.ts` | 564 | 混合（要拆） | impl/mods/AgentModLoader.ts<br>utils/mods/agent-mod-loader.ts<br>types/mods.ts | PayloadRequiredAxes / DataOnlyAxes 可变 Set 且出包 → 冻结数组进 contract/constants.ts（AgentModAxes） |
| `AgentModProjection.ts` | 247 | 纯函数 | utils/mods/agent-mod-projection.ts<br>types/mods.ts |  |
| `AgentModRegistry.ts` | 233 | 混合（要拆） | impl/mods/AgentModRegistry.ts<br>impl/errors/AgentModStaleSnapshotError.ts<br>types/mods.ts | AgentModRegistry 进 impl/mods/；AgentModStaleSnapshotError 进 impl/errors/，按错误码判断 |
| `AgentModSeams.ts` | 616 | 混合（要拆） | impl/mods/AgentModSeamDispatcher.ts<br>utils/mods/agent-mod-seams.ts<br>types/mods.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | AgentModSeamDispatcher 进 impl/mods/；WiredSeamKinds 等可变 Set → 冻结进 constants；17 个类型进 types/mods.ts；别名 AgentModHookDispatcher 删除；数字 5 处 |
| `BuiltinAgentMod.ts` | 180 | 纯函数 | impl/AgentTools.ts（分组与内置 mod 定义）<br>contract/constants.ts（AgentIdentity.builtinModId） | 内置 mod 的分组与挂载 → 并进 impl/AgentTools.ts 末尾（同 system 的 createSystemBundledModDefinition）；BuiltinAgentModId 进 constants |
| `VelarModArchiveImporter.ts` | 516 | 混合（要拆） | impl/mods/VelarModArchiveImporter.ts<br>utils/mods/velar-mod-archive-importer.ts<br>types/mods.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts<br>端口 → contract/requires.ts：VelarModArchiveSignatureVerifier | 类进 impl/mods/；32 处英文报错全改中文 + 错误码；8 个上限数字进 constants（导入上限对宿主承诺）；英文文案 32 处；数字 8 处 |
| `index.ts` | 100 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/node/`（2 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ToolContractExecutionFacade.ts` | 327 | 混合（要拆） | impl/assembly/ToolContractExecutionFacade.ts<br>utils/tools/tool-contract-execution-facade.ts<br>types/execution.ts | 类进 impl/assembly/；./node 入口并入根入口（根入口本就只给 Node） |
| `index.ts` | 2 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/prompts/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `catalog.ts` | 217 | 纯函数 | utils/guidance/catalog.ts<br>types/guidance.ts | createBuiltInPromptRegistry（new PromptRegistry）→ 工厂进 impl/guidance/PromptRegistry.ts；段目录函数进 utils/guidance/catalog.ts；登记在 project 提示词审核指纹 |
| `index.ts` | 33 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `registry.ts` | 348 | 混合（要拆） | impl/guidance/PromptRegistry.ts<br>utils/guidance/registry.ts<br>types/guidance.ts | PromptRegistry 进 impl/guidance/；PromptSegmentIdAliases 冻结 |

#### `src/prompts/segments/`（4 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `index.ts` | 10 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `runtime.ts` | 156 | 纯函数 | utils/guidance/runtime.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `shared.ts` | 207 | 混合（函数+类型） | utils/guidance/shared.ts<br>types/guidance.ts |  |
| `task.ts` | 35 | 纯函数 | utils/guidance/task.ts |  |

#### `src/protocol/`（11 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `agent-capability.ts` | 189 | 混合（函数+类型） | utils/wire/agent-capability.ts（解析与信封构造）<br>types/agent.ts<br>contract/constants.ts（AgentProtocolVersions.agentCapability*） | 英文文案 2 处；数字 3 处 |
| `execution.ts` | 84 | 类型+常量 | utils/wire/execution.ts（zod schema）<br>types/agent.ts（9 个 z.infer 改手写） |  |
| `external-agent-bridge.ts` | 217 | 混合（函数+类型） | utils/wire/external-agent-bridge.ts（zod schema 与解析）<br>types/agent.ts<br>contract/constants.ts（AgentProtocolVersions.externalAgentBridge、描述符） | 同上；check:agent-arch 按路径钉了标记串 |
| `index.ts` | 16 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `lease.ts` | 143 | 类型+常量 | utils/wire/lease.ts（zod schema）<br>types/agent.ts（8 个 z.infer 改手写）<br>contract/constants.ts（AgentToolNames.catalog/schema、租约上限） | 数字 2 处 |
| `message.ts` | 52 | 类型+常量 | utils/wire/message.ts（zod schema）<br>types/agent.ts（3 个 z.infer 改手写） |  |
| `mods.ts` | 715 | 混合（函数+类型） | utils/wire/mods.ts（zod schema 与 parseAgentModManifest）<br>types/agent.ts（14 个 z.infer 改手写）<br>contract/constants.ts（AgentModAxes） | zod schema 进 utils/wire/mods.ts；14 个 z.infer 类型改为 types/agent.ts 里手写的类型，schema 用 satisfies z.ZodType<T> 对齐；parseAgentModManifest 经 agentWire 实例出包 |
| `observability.ts` | 168 | 混合（函数+类型） | utils/wire/observability.ts（zod schema）<br>types/agent.ts（10 个 z.infer 改手写） | 同上；check:agent-arch 防线⑤钉了路径与标记串 |
| `product-surface.ts` | 111 | 混合（函数+类型） | utils/wire/product-surface.ts<br>types/agent.ts | 数字 7 处 |
| `session.ts` | 265 | 类型+常量 | utils/wire/session.ts（zod schema）<br>types/agent.ts（22 个 z.infer 改手写） | 22 个 z.infer 类型同上处理 |
| `version.ts` | 3 | 常量 | contract/constants.ts（AgentProtocolVersions.agent） | AgentProtocolVersion → constants |

#### `src/protocol/constants/`（4 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `chatStorage.ts` | 3 | 常量 | contract/constants.ts（AgentProtocolVersions.chatStorageSchema） | CHAT_STORAGE_SCHEMA_VERSION → constants |
| `promptFeatures.ts` | 16 | 纯函数 | utils/wire/prompt-features.ts |  |
| `steps.ts` | 35 | 纯函数 | contract/constants.ts（AgentStepLimits）<br>utils/wire/steps.ts | 步数上下限对外承诺 → constants（AgentStepLimits）；数字 5 处 |
| `typedFieldAsserts.ts` | 171 | 纯函数 | contract/constants.ts（AgentFieldValues）<br>utils/wire/typed-field-asserts.ts | 五组取值表（ReasoningLevelValues…）→ constants；assert/parse 函数进 utils/wire/，经 agentWire 实例出包 |

#### `src/protocol/types/`（13 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `agent.ts` | 638 | 类型 | types/agent.ts（可移植）<br>端口 → contract/requires.ts：ToolExecutionApi（带方法，宿主经执行服务提供） | 42 个类型；带方法的（ToolExecutionApi、RunProfileRuntimePolicy…）不能进可移植文件 → types/runner.ts 或 requires |
| `agentWorkflow.ts` | 154 | 类型 | types/agent.ts（可移植） |  |
| `chatRuntime.ts` | 453 | 需改类（闭包/对象字面量） | types/agent.ts（可移植）<br>contract/constants.ts（ChatRuntimeEvents、StreamRuntimeStateKinds） | ChatRuntimeEvents 对象字面量（Desktop 7、Workbench 5）→ 冻结表进 contract/constants.ts；三组 STREAM_*_KINDS → constants；3 个 import 的 core 函数挪走 |
| `execution.ts` | 262 | 类型 | types/agent.ts（可移植） |  |
| `index.ts` | 1432 | 混合（函数+类型） | types/agent.ts（可移植；约 140 个数据类型）<br>types/chat.ts（带回调的 ChatSessionContextViewStore 等）<br>utils/wire/conversation-kind.ts（4 个判定函数） | 1432 行 149 个类型 + 4 个判定函数：数据类型进可移植文件 types/agent.ts；resolveChatMessageConversationKind 等 4 个函数进 utils/wire/，经 ./chat 的 chatMessages 实例出包；import 的 ContextUsageEstimate（反向依赖运行时）搬进 types |
| `runProfile.ts` | 3 | 类型 | types/agent.ts（可移植） |  |
| `skill.ts` | 68 | 类型 | types/agent.ts（可移植） |  |
| `storage.ts` | 27 | 纯函数 | types/agent.ts（可移植）<br>utils/wire/storage.ts（branchTimelineKey）<br>contract/constants.ts（DEFAULT_ACTIVE_BRANCH_ID） |  |
| `subAgentTask.ts` | 175 | 类型 | types/agent.ts（可移植） |  |
| `system.ts` | 44 | 类型 | types/agent.ts（可移植） |  |
| `team.ts` | 41 | 类型 | types/agent.ts（可移植） |  |
| `tool.ts` | 380 | 类型 | types/agent.ts（可移植） | 51 个类型（ToolPermission、ToolCategoryDefinition、ToolCapabilitySchema… 六个空间包在用）→ 可移植文件 types/agent.ts |
| `turnContext.ts` | 126 | 类型 | types/agent.ts（可移植） |  |

#### `src/reminders/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `index.ts` | 12 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `scheduler.ts` | 176 | 类 | impl/session/RuntimeReminderScheduler.ts<br>types/session.ts |  |
| `types.ts` | 90 | 类型 | types/session.ts<br>端口 → contract/requires.ts：RuntimeReminderProducer、ReminderCapabilityResolver |  |

#### `src/remote/`（4 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `RemoteHostService.ts` | 198 | 混合（要拆） | impl/connectors/RemoteHostService.ts<br>utils/connectors/remote-host-service.ts<br>types/connectors.ts<br>端口 → contract/requires.ts：RemoteHostServicePorts |  |
| `contracts.ts` | 32 | 类型+常量 | types/connectors.ts<br>contract/constants.ts（AgentIdentity.remoteHostToolCategory） |  |
| `index.ts` | 4 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `remote-tool.ts` | 110 | 混合（函数+类型） | impl/connectors/RemoteHostToolFactory.ts（★ 动态工具工厂）<br>types/connectors.ts | createRemoteHostTool 是动态工具工厂（按远端清单生成工具），不属于静态工具定义 → impl/connectors/RemoteHostToolFactory 或 utils/connectors/，不用 defineVelaTool |

#### `src/remote/mcp/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `RemoteNodeMcpBridge.ts` | 163 | 纯函数 | impl/connectors/RemoteNodeMcpServer.ts（★）<br>utils/connectors/remote-node-mcp.ts | createRemoteNodeMcpServer → impl/connectors/RemoteNodeMcpServer 类 + 工厂 |
| `index.ts` | 7 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `stdio-entry.ts` | 100 | 纯函数 | utils/connectors/stdio-entry.ts（runRemoteNodeMcpStdio 经 RemoteNodeMcpServerApi 出包） | 读 VELAROS_REMOTE_NODE_URL / PAIRING_CODE → 登记环境变量表；runRemoteNodeMcpStdio 是可执行入口，Termel 在用 |

#### `src/runtime/`（1 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `index.ts` | 45 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/session/`（9 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `archive.ts` | 120 | 纯函数 | utils/product-session/archive.ts<br>types/product-session.ts | 12 处英文报错；VelarosAgentSessionArchive* 身份常量进 constants；4 处数字缺省；英文文案 12 处；数字 4 处 |
| `contracts.ts` | 121 | 类型+常量 | contract/requires.ts（四个端口）<br>types/product-session.ts<br>utils/wire/product-session.ts（两个 zod schema）<br>端口 → contract/requires.ts：AgentSessionCatalogPort、AgentSessionLeasePort、AgentBackgroundAgentPort、AgentBackgroundAgentControlPort |  |
| `event-port.ts` | 20 | 类型 | types/product-session.ts<br>端口 → contract/requires.ts：AgentSessionEventPort |  |
| `goals.ts` | 85 | 混合（要拆） | impl/product-session/AgentGoalService.ts<br>utils/product-session/goals.ts<br>types/product-session.ts | 英文文案 4 处 |
| `index.ts` | 32 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `lifecycle.ts` | 57 | 纯函数 | impl/errors/AgentSessionLeaseConflictError.ts<br>utils/product-session/lifecycle.ts | AgentSessionLeaseConflictError 进 impl/errors/，外部按错误码判断；Termel 在用 → 迁移表写明；英文文案 4 处；数字 1 处 |
| `permissions.ts` | 131 | 混合（函数+类型） | utils/product-session/permissions.ts<br>types/product-session.ts | 英文文案 1 处 |
| `plans.ts` | 252 | 混合（要拆） | impl/product-session/AgentPlanService.ts<br>utils/product-session/plans.ts<br>types/product-session.ts | AgentPlanService 进 impl/product-session/；11 个函数进 utils/product-session/；8 处英文；英文文案 8 处 |
| `questions.ts` | 149 | 混合（要拆） | impl/product-session/AgentQuestionService.ts<br>utils/product-session/questions.ts<br>types/product-session.ts | 英文文案 4 处 |

#### `src/skills/`（6 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AgentSkillProvider.ts` | 130 | 混合（函数+类型） | utils/guidance/agent-skill-provider.ts<br>types/guidance.ts<br>端口 → contract/requires.ts：AgentSkillProvider | 数字 1 处 |
| `AgentSkillRepository.ts` | 367 | 类 | impl/guidance/AgentSkillRepository.ts |  |
| `FileSkillProvider.ts` | 70 | 混合（要拆） | impl/guidance/FileSkillProvider.ts<br>utils/guidance/file-skill-provider.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `SkillFileStore.ts` | 541 | 混合（要拆） | impl/guidance/SkillFileStore.ts<br>utils/guidance/skill-file-store.ts<br>types/guidance.ts | 类进 impl/guidance/；parseFrontmatter 等 5 个函数（Desktop 4 处）进 utils/guidance/ 并经 SkillFileStoreApi 暴露；7 个错误码串改 AppError 码 + 中文；英文文案 7 处 |
| `SkillMarketClient.ts` | 231 | 类 | impl/guidance/SkillMarketClient.ts<br>types/guidance.ts | 类进 impl/guidance/；8 个错误码串同上；英文文案 8 处 |
| `index.ts` | 19 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/sub-agent/`（6 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `StructuredOutput.ts` | 245 | 纯函数 | utils/delegation/structured-output.ts<br>types/delegation.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | MaxStructuredOutputBytes / SchemaBytes 写进模型说明 → constants；函数进 utils/delegation/；数字 5 处 |
| `SubAgentReadonlyPolicy.ts` | 16 | 纯函数 | utils/delegation/sub-agent-readonly-policy.ts |  |
| `SubAgentResultBuilder.ts` | 108 | 纯函数 | utils/delegation/sub-agent-result-builder.ts<br>types/delegation.ts |  |
| `SubAgentSessionStore.ts` | 427 | 混合（要拆） | impl/delegation/SubAgentSessionStore.ts<br>utils/delegation/sub-agent-session-store.ts<br>types/delegation.ts | 类进 impl/delegation/ |
| `SubAgentTypeRegistry.ts` | 86 | 混合（函数+类型） | utils/delegation/sub-agent-type-registry.ts<br>types/delegation.ts<br>端口 → contract/requires.ts：SubAgentTypeProvider | 英文文案 1 处 |
| `index.ts` | 37 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/team/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `WriteLease.ts` | 72 | 类 | impl/delegation/WriteLeaseCoordinator.ts<br>types/delegation.ts | WriteLeaseCoordinator 进 impl/delegation/ |
| `index.ts` | 11 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `model-router.ts` | 90 | 混合（要拆） | impl/delegation/TeamModelRouter.ts<br>types/delegation.ts<br>端口 → contract/requires.ts：TeamModelRoutingPort | TeamModelRouter 进 impl/delegation/；TeamModelRoutingPort → requires；check:agent-arch 钉了构造器签名 |

#### `src/tool-contract/`（14 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ForgivingSchema.ts` | 113 | 纯函数 | utils/toolkit/forgiving-schema.ts<br>types/toolkit.ts | 数字 1 处 |
| `ToolDescription.ts` | 441 | 混合（函数+类型） | utils/toolkit/tool-description.ts<br>types/toolkit.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 19 个函数进 utils/toolkit/tool-description.ts；ToolDescriptionBudget 等上限 → constants；5 处英文报错；英文文案 5 处；数字 2 处 |
| `ToolInputBounds.ts` | 251 | 混合（函数+类型） | utils/toolkit/tool-input-bounds.ts<br>types/toolkit.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `approval.ts` | 136 | 需改类（闭包/对象字面量） | impl/tools/DefaultDenyApprovalPort.ts（★）<br>impl/tools/UnattendedSubAgentApprovalPort.ts（★）<br>utils/toolkit/approval.ts<br>端口 → contract/requires.ts：ApprovalPort | defaultDenyApprovalPort 对象字面量 → 文件末尾带 ApprovalPort 类型的实例（impl/tools/DefaultDenyApprovalPort 类）；createUnattendedSubAgentApprovalPort 闭包工厂同理；ApprovalPort 接口 → requires |
| `concepts.ts` | 30 | 纯函数 | utils/toolkit/concepts.ts<br>types/toolkit.ts |  |
| `define.ts` | 273 | 纯函数 | utils/toolkit/define.ts<br>types/toolkit.ts | defineToolRuntimeSpec 等进 utils/toolkit/define.ts，形参里的 ToolContractExampleRegistry 改最小形状；对外经 agentToolContracts 实例（./tool-contract）出包；英文文案 1 处 |
| `discovery.ts` | 55 | 纯函数 | utils/toolkit/discovery.ts | 数字 1 处 |
| `examples.ts` | 53 | 混合（要拆） | impl/tools/ToolContractExampleRegistry.ts<br>utils/toolkit/examples.ts | ToolContractExampleRegistry 进 impl/tools/；进程级单例 DefaultToolContractExampleRegistry 被 defineToolRuntimeSpec 顺手写入（隐藏副作用）→ 改为显式：示例留在工具规格上，需要全集的地方从工具集合收集；英文文案 2 处 |
| `identity.ts` | 16 | 纯函数 | utils/toolkit/identity.ts | 英文文案 1 处 |
| `index.ts` | 17 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `interaction.ts` | 50 | 需改类（闭包/对象字面量） | impl/tools/UnsupportedInteractionPort.ts（★）<br>端口 → contract/requires.ts：InteractionPort | defaultUnsupportedInteractionPort 同上；InteractionPort → requires |
| `schema-bundle.ts` | 384 | 混合（函数+类型） | utils/toolkit/schema-bundle.ts<br>types/toolkit.ts | 数字 1 处 |
| `task-approval.ts` | 108 | 纯函数 | utils/toolkit/task-approval.ts<br>types/toolkit.ts |  |
| `types.ts` | 207 | 类型 | types/toolkit.ts | ToolContractRuntimeSpec / DefineToolRuntimeSpecInput / ToolContractSurface（六个空间包在用）→ types/toolkit.ts 并随 ./tool-contract 出包 |

#### `src/tool-library/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `KernelToolContext.ts` | 193 | 类型 | types/tool-context.ts<br>端口 → contract/requires.ts：AgentToolContext（原 KernelToolContext 的宿主部分）、ToolSkillsApi | 工具上下文：宿主提供、工具会调的成员 → requires 的 AgentToolContext（宿主端口）；loop 自己维护的可见工具/传输名等成员 → types/tool-context.ts 的内部 RunnerToolState，不进注入面；ExecutionEventBus 类型改 ExecutionEventBusApi |
| `defineVelaTool.ts` | 38 | 混合（函数+类型） | utils/builtin/define-agent-tool.ts（toolDefiner 的声明）<br>contract/provides.ts（VelaTool 类型） | 登记为 toolDefiner（只许在 impl/AgentTools.ts 里调）；函数进 utils/builtin/define.ts；VelaTool 类型进 contract/provides.ts（同 system） |
| `index.ts` | 20 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |

#### `src/tool-library/builtin/`（29 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ActiveDirectives.tool.ts` | 188 | 工具定义 | impl/AgentTools.ts（directive:list/upsert/archive） |  |
| `ActiveDirectives.ts` | 286 | 混合（函数+类型） | impl/builtin/DirectiveOperations.ts（★）<br>utils/builtin/active-directives.ts<br>types/builtin.ts<br>contract/constants.ts（AgentToolLimits.directives） | 英文文案 2 处 |
| `AgentWorkflow.tool.ts` | 91 | 工具定义 | impl/AgentTools.ts（agent:run_workflow） |  |
| `AgentWorkflow.ts` | 243 | 类型+常量 | utils/builtin/workflow-schemas.ts<br>types/builtin.ts<br>contract/constants.ts（AgentToolLimits.workflow） |  |
| `BackgroundJobs.tool.ts` | 173 | 工具定义 | impl/AgentTools.ts（job:read_output/wait/cancel） | 数字 1 处 |
| `BackgroundJobs.ts` | 193 | 混合（函数+类型） | impl/builtin/BackgroundJobOperations.ts（★）<br>utils/builtin/background-jobs.ts<br>types/builtin.ts |  |
| `Capabilities.ts` | 98 | 常量 | impl/AgentTools.ts（能力声明内联进各工具定义） | 10 个工具能力声明常量 → 各工具定义里内联或 constants |
| `Categories.tool.ts` | 153 | 工具定义 | impl/AgentTools.ts（tooling:map/read/replace） |  |
| `Categories.ts` | 58 | 纯函数 | impl/builtin/ToolSpaceOperations.ts（★ runToolSpace 的派发） |  |
| `ContextDistill.tool.ts` | 98 | 工具定义 | impl/AgentTools.ts（context:distill，建议删，见第 5 节） | 数字 3 处 |
| `ContextHandoff.tool.ts` | 74 | 工具定义 | impl/AgentTools.ts（context:handoff） | 数字 1 处 |
| `ContextRetrieval.tool.ts` | 176 | 工具定义 | impl/AgentTools.ts（context:recall）<br>impl/builtin/ContextRecallOperations.ts（★ execute 的 29 条语句下沉） |  |
| `ContextRetrieval.ts` | 162 | 纯函数 | utils/builtin/context-retrieval.ts<br>types/builtin.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 2 处 |
| `DispatchAgent.tool.ts` | 114 | 工具定义 | impl/AgentTools.ts（agent:dispatch） |  |
| `DispatchAgent.ts` | 225 | 类型+常量 | utils/builtin/dispatch-schemas.ts<br>types/builtin.ts |  |
| `Goals.tool.ts` | 425 | 工具定义 | impl/AgentTools.ts（goal:get/create/update）<br>impl/builtin/GoalOperations.ts（★ 下沉 29 条语句） | 英文文案 1 处 |
| `Goals.ts` | 321 | 混合（函数+类型） | utils/builtin/goals.ts<br>types/builtin.ts | 英文文案 1 处 |
| `Plans.tool.ts` | 322 | 工具定义 | impl/AgentTools.ts（plan:get/update）<br>impl/builtin/PlanOperations.ts（★ 下沉 23 条语句与 findPlanArtifact/readPlanLifecycle） |  |
| `Plans.ts` | 129 | 混合（函数+类型） | utils/builtin/plans.ts<br>types/builtin.ts |  |
| `SkillLoadConfirmation.ts` | 75 | 纯函数 | utils/builtin/skill-load-confirmation.ts |  |
| `StepRefs.ts` | 248 | 混合（函数+类型） | utils/builtin/step-refs.ts<br>types/builtin.ts | 英文文案 1 处 |
| `ToolReadDetails.ts` | 27 | 纯函数 | utils/builtin/tool-read-details.ts<br>types/builtin.ts |  |
| `ToolSearchTerms.ts` | 158 | 纯函数 | utils/builtin/tool-search-terms.ts |  |
| `ToolSpaceActivation.ts` | 412 | 混合（函数+类型） | utils/builtin/tool-space-activation.ts<br>types/builtin.ts |  |
| `ToolSpaceQueries.ts` | 641 | 纯函数 | utils/builtin/tool-space-queries.ts<br>types/builtin.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | ToolOsStateValues 冻结；引用恒空的 PluginBackedToolCategoryIds（删）；英文文案 1 处；数字 1 处 |
| `ToolSpaceReplace.ts` | 438 | 纯函数 | utils/builtin/tool-space-replace.ts<br>types/builtin.ts |  |
| `ToolSpaceSchemas.ts` | 484 | 混合（函数+类型） | utils/builtin/tool-space-schemas.ts<br>types/builtin.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 工具入参 schema 与解析 → utils/builtin/tool-space-schemas.ts；上限 ToolSpaceQueryPageLimitMax → constants；数字 1 处 |
| `ToolSpaceSearch.ts` | 281 | 混合（函数+类型） | utils/builtin/tool-space-search.ts<br>types/builtin.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 1 处 |
| `ToolSpaceSkillRead.ts` | 128 | 纯函数 | utils/builtin/tool-space-skill-read.ts<br>types/builtin.ts |  |

#### `src/tool-library/context/`（5 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ActiveContextTypes.ts` | 38 | 类型 | types/tool-context.ts<br>端口 → contract/requires.ts：ToolActiveContextApi |  |
| `CodingSessionTypes.ts` | 167 | 类型 | types/tool-context.ts |  |
| `ConversationContextTypes.ts` | 44 | 类型 | types/tool-context.ts<br>端口 → contract/requires.ts：ToolConversationContextApi |  |
| `RoleContextTypes.ts` | 14 | 类型 | types/tool-context.ts<br>端口 → contract/requires.ts：ToolRoleApi |  |
| `RuntimeContextTypes.ts` | 11 | 类型 | types/tool-context.ts<br>端口 → contract/requires.ts：ToolRuntimeApi |  |

#### `src/tool-library/mcp/`（5 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `McpClientConnection.ts` | 465 | 混合（要拆） | impl/connectors/McpClientConnection.ts<br>impl/errors/McpAuthorizationRequiredError.ts<br>types/connectors.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts<br>端口 → contract/requires.ts：McpAuthorizationProvider | McpClientConnection 进 impl/connectors/，McpAuthorizationRequiredError 进 impl/errors/；超时常量（宿主在用）→ constants；5 处英文；英文文案 5 处；数字 2 处 |
| `index.ts` | 31 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `mcpApprovalArguments.ts` | 44 | 纯函数 | utils/connectors/mcp-approval-arguments.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 2 处 |
| `mcpCallResult.ts` | 162 | 纯函数 | utils/connectors/mcp-call-result.ts<br>types/connectors.ts |  |
| `mcpToolTranslation.ts` | 223 | 混合（函数+类型） | utils/connectors/mcp-tool-translation.ts<br>types/connectors.ts | 形参里的 McpClientConnection 改最小形状 McpToolCaller；函数经 mcpToolTranslator 实例出包 |

#### `src/tool-library/network/`（1 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `FetchSafety.ts` | 205 | 纯函数 | impl/connectors/SafeHttpFetch.ts（★ 实例 safeHttpFetch）<br>utils/connectors/fetch-safety.ts | SSRF 门：safeFetch / assertSafeHttpFetchUrl（Desktop 在用）→ impl/connectors/SafeHttpFetch 类 + 实例出包；5 处英文；英文文案 5 处；数字 1 处 |

#### `src/tools/`（23 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ExecutionPolicy.ts` | 968 | 混合（要拆） | impl/tools/ToolExecutionPolicy.ts<br>types/tools.ts | ToolExecutionPolicy 进 impl/tools/；check:agent-arch 防线④⑤钉了标记串；英文文案 3 处 |
| `ExecutionPolicyFailures.ts` | 313 | 混合（函数+类型） | utils/tools/execution-policy-failures.ts<br>types/tools.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 4 处 |
| `Executor.ts` | 1618 | 混合（要拆） | impl/tools/ToolExecutor.ts<br>utils/tools/executor.ts<br>types/tools.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | ToolExecutor 进 impl/tools/（47 个私有方法 6 个不用 this → utils/tools/）；emitToolProgressEvent 等 3 个函数进 utils/tools/；check:agent-arch 按路径钉了标记串；登记在 project 提示词审核指纹；英文文案 2 处；数字 2 处 |
| `ToolArgsSchemaValidator.ts` | 598 | 纯函数（无状态类改函数） | utils/tools/tool-args-schema-validator.ts<br>types/tools.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 只有常量字段的单例类 → utils/tools/tool-args-validator.ts 的函数；登记在 project 提示词审核指纹；英文文案 2 处；数字 3 处 |
| `ToolIdentity.ts` | 263 | 需改类（闭包/对象字面量） | impl/tools/ProviderToolReferenceCanonicalizer.ts（★）<br>utils/tools/tool-identity.ts<br>types/tools.ts | createProviderToolReferenceCanonicalizer 闭包工厂 → impl/tools/ProviderToolReferenceCanonicalizer 类；其余函数进 utils/tools/；Desktop/Workbench 用的传输名函数经 toolTransportNames 实例出包；4 处英文；英文文案 4 处 |
| `access-decision.ts` | 130 | 混合（函数+类型） | utils/tools/access-decision.ts<br>types/tools.ts |  |
| `access-policy.ts` | 69 | 混合（函数+类型） | utils/tools/access-policy.ts<br>types/tools.ts |  |
| `capability-registry.ts` | 255 | 混合（要拆） | impl/tools/ToolCapabilityRegistry.ts<br>utils/tools/capability-registry.ts |  |
| `capability-types.ts` | 63 | 类型 | types/tools.ts |  |
| `discovery-availability.ts` | 132 | 混合（函数+类型） | utils/tools/discovery-availability.ts<br>types/tools.ts |  |
| `historyPreviewPlaceholder.ts` | 55 | 纯函数 | utils/tools/history-preview-placeholder.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 2 处 |
| `index.ts` | 132 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
| `model-input-policy.ts` | 35 | 纯函数 | utils/tools/model-input-policy.ts<br>types/tools.ts |  |
| `modelImageLift.ts` | 167 | 纯函数 | utils/tools/model-image-lift.ts<br>types/tools.ts |  |
| `projectReadSerialization.ts` | 157 | 混合（函数+类型） | utils/tools/project-read-serialization.ts<br>types/tools.ts | project 空间知识（project:read 结果的源码窗口）→ 搬到 packages/project，作为新扩展点 ToolResultBudgetFitter 的实现注入（现有 ToolResultMiddleware 不够，见 1.5 节 P0-1） |
| `prompt-feature-policy.ts` | 44 | 需改类（闭包/对象字面量） | impl/tools/DefaultPromptFeaturePolicy.ts（★ 实例）<br>端口 → contract/requires.ts：RuntimePromptFeaturePolicy | defaultRuntimePromptFeaturePolicy 对象字面量 → 带 RuntimePromptFeaturePolicy 类型的实例；接口 → requires |
| `registry.ts` | 321 | 混合（要拆） | impl/tools/ToolRegistry.ts<br>utils/tools/registry.ts<br>types/tools.ts | ToolRegistry 进 impl/tools/；别名 ToolRegistryHelper 删除 |
| `tool-space-recovery.ts` | 42 | 纯函数 | utils/tools/tool-space-recovery.ts<br>types/tools.ts |  |
| `tool-space-resolver.ts` | 793 | 混合（函数+类型） | utils/tools/tool-space-resolver.ts<br>types/tools.ts | 死代码：PluginBackedToolCategoryIds 恒空、isPluginBackedToolCategory 恒 false、PluginFeatureDescriptions 恒空 {} → 删除及 capability-registry.ts:205、本文件 380/471/566 的分支 |
| `toolInputHistoryProjection.ts` | 104 | 纯函数 | utils/tools/tool-input-history-projection.ts<br>types/tools.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | 数字 4 处 |
| `toolInputRecall.ts` | 39 | 纯函数 | utils/tools/tool-input-recall.ts |  |
| `toolResultSerialization.ts` | 662 | 纯函数 | utils/tools/tool-result-serialization.ts<br>types/tools.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | ModelToolResultLimits 等三组上限：写进模型可见文案的进 constants，其余进 tuning；Desktop 在用的 compact*/serialize* 经 ./chat 实例出包；数字 9 处 |
| `types.ts` | 82 | 类型 | types/tools.ts |  |

#### `src/tools/recovery/`（3 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `ExecutionProgress.ts` | 98 | 混合（要拆） | impl/tools/ExecutionProgress.ts<br>utils/tools/execution-progress.ts |  |
| `ToolInputReuse.ts` | 378 | 混合（函数+类型） | impl/tools/ToolInputReuseStore.ts（★ 取代模块级 claims 锁表）<br>impl/errors/ToolInputReuseError.ts<br>utils/tools/tool-input-reuse.ts<br>types/tools.ts | 模块级 WeakSet reusableSchemas + Map claims（按身份串行化的锁表）→ impl/tools/ToolInputReuseStore 类（归 ToolExecutor 持有）；schema 标记改为 schema 上的品牌字段；ToolInputReuseError → impl/errors/ + 错误码；9 处英文；登记在 project 提示词审核指纹；**模块级可变状态**：reusableSchemas、claims；英文文案 9 处 |
| `TransientRecoveryProjection.ts` | 158 | 纯函数 | utils/tools/transient-recovery-projection.ts<br>types/tools.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | RecoveryToolNames = project:edit / project:file…、RecoveryKinds = project-edit-candidates… 写死 project 工具名 → 见耦合清单；登记在 project 提示词审核指纹；数字 1 处 |

#### `src/workflow/`（2 个文件）

| 现文件 | 行 | 分类 | 去处 | 说明 |
| --- | ---: | --- | --- | --- |
| `AgentWorkflowRuntime.ts` | 605 | 混合（要拆） | impl/runner/AgentWorkflowRuntime.ts<br>impl/errors/WorkflowBudgetExhaustedError.ts<br>impl/errors/WorkflowAbortedError.ts<br>utils/runner/agent-workflow-runtime.ts<br>types/runner.ts<br>数字 → utils/tuning.ts 或 contract/constants.ts | AgentWorkflowRuntime 进 impl/runner/（AgentRunner 经 AgentWorkflowCoordinator 引它，必须在 runner 层或更低）；两个错误类进 impl/errors/；MaxWorkflow* 上限写进工具说明 → constants；模块级 TextEncoder 单例改 private static readonly；数字 5 处 |
| `index.ts` | 2 | 入口 | 删除；对外转发改由 src/exports/*.ts 承担 |  |
