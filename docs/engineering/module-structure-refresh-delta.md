# 模块布局与文档同步差量

本轮按 `contract/types/impl/utils` 统一 Agent、Context 的实际源码、治理登记和现行文档。范围是结构与接入说明；正式执行仍使用现有 Agent Loop、ScriptAct、Kernel、ContextStorage 和 ProviderRequestCompiler。

## 文件与分层

| 位置 | 变化及理由 |
| --- | --- |
| `packages/agent/src/contract/` | provides 登记 ActRunServiceApi、AgentSupervisorApi；requires 集中宿主端口；constants 集中子任务交付上限 |
| `packages/agent/src/types/` | act/delegation 保存输入、运行和子任务数据；runtime 保存活动运行的内部工作类型 |
| `packages/agent/src/impl/` | ActLoop、ActRunService、AgentSupervisor 的接口放到各自类上方；运行服务直接构造内部 ActLoop |
| `packages/context/src/contract/` | provides 登记六个公开类接口；requires 保存存储、来源、规划与生命周期端口；constants 集中三个限制表和五个 JSON Schema |
| `packages/context/src/types/` | context/store/activity 按数据职责保留文件，runtime 保存 CAS 变换接口 |
| `packages/context/src/impl/` | 会话、物化、证据、日志、活动账本的接口与实现同文件；存储适配器继续 implements requires 中的端口 |
| 两包 `src/utils/tuning.ts` | 集中原有分页、活动账本容量与 diff 编辑步数，数值保持一致 |
| `context/src/utils/view.ts` | 从 ContextEvidenceBuilder 提取不使用实例状态的候选校验，条件和错误保持一致 |
| `context/package.json` | 构建先 clean，防止发布目录遗留迁移前的实现文件 |
| `scripts/ownership/` | 两包使用统一检查器并显式登记层级，移除专用 interface 分支；补齐工作区新增 Runtime 类的分层登记 |
| `scripts/agent/check-arch-boundaries.mjs` | 骨干链路断言对应 `new ActLoop`，仍检查唯一发送与执行路径 |

Agent 层级为运行服务/调度器 → ActLoop。Context 层级为会话编排/本地适配装配 → 物化、会话状态、日志、Store 及账本 → 来源访问与活动广播。公开包入口保持 Agent 的 `.` / `./contracts` 和 Context 的 `.` / `./contracts` / `./node`。

## 对外合同差量

- **Agent provides/requires**：文件位置与登记方式变更；公开工厂、方法和类型名称保持一致，现有公开 API 基线通过。ActLoopApi 是内部实现接口。
- **Context provides/requires**：公开接口移到对应类上方并通过 provides 登记；requires 路径迁到 contract。ContextStorage、StoreStorage 和来源/规划等方法签名保持一致。上一轮的存储生命周期约定见 [存储差量](act-storage-abstraction-delta.md)。
- **Context 数据导出**：收回 `ContextPlan` 的公开导出，作为物化器内部计划使用；移除公开接口及仓内调用方均不引用的 `TurnContextAnchor`、`TurnContextSourcePeekResult`。这是类型导出收口，仓外若直接引用这三项，需要调整到所消费的实际接口。
- **StoreEventCard**：改成元数据接口，StoreEvent 继承它并增加 value；对象形状保持一致，StoreStorage 的公开签名现在明确关联元数据类型。
- **Context 常量**：ContextLimits、StoreLimits、DefaultContextViewLimits 及五个 Schema 集中为无导入冻结表。8 份运行时值逐项比对一致；DefaultContextViewLimits 的声明由常量表推导为只读字面量，预算覆盖继续使用 ContextViewLimits / Partial<ContextViewLimits>。
- **工具定义与模板**：本次没有修改模型操作、参数 schema 的内容、效果或模板源码；实际可用清单由生成检查核验。文档新增的用法说明指向真实操作定义和按需模板。

## 文档范围

- AGENTS.md、module-ownership、code-standard、gate-coverage-matrix：统一四类职责、类接口位置、注入、分层、公开入口、模板生成及运行环境规则。
- 中英文 README、CONTRIBUTING、docs/readme、repository-topology、platform-boundaries：按当前八包布局和产品所有权更新接入说明。
- Agent/Context 模块卡片与 README，以及 Model、Shell、Sandbox、Velaros 的相关说明：修正依赖方向、真实合同位置、文本/JSON 驱动区别和模板位置。
- system-space、runtime-assurance、script-output-observation：同步 store 消息操作、存储端口、请求编译位置和观察容量策略。
- mod-dev 全套指南与 agent-mod-trunk：按当前 Kernel 信封、KernelModuleDefinition、OperationModuleDefinition 和 Runtime 注入面重写；按职责索引指向实际接入方式。
- 设计输入包保持原始规格；阶段设计、差量报告和地基评审补充历史适用范围，并指向当前架构与模块规范。

## 验收差量

Context 的 INV-1 至 INV-6 补齐现有用例名称中的编号，INV-12 用 describe 组织已有适配器合同用例。断言、预算、错误预期和存储承诺保持一致，没有通过减弱验收消除问题。ActLoop 新增计时逻辑中的判空写法按共享 helper 规范等价调整。

## 验证结果

- Context：62 项 Node 测试 + 8 项 Bun 测试通过，包含 SQLite 和无 SQLite 的存储替换链路所依赖的合同测试。
- Agent：22 项测试通过；浏览器入口检查、公开 API 基线和骨干依赖检查通过。
- Act：全量 373 项 mjs 回归通过，覆盖脚本、观察、租约、上下文、搜索、子任务、共享 store、消息和无 SQLite Runtime。
- Agent、Context、Velaros 构建及类型检查通过；Context 的 8 份 schema/限制表比对一致。
- `check:script` 通过，含 2 项生成器测试；`check:act-catalog` 通过，12 种投影、43 项去重用法与实际定义一致。
- 本次 Agent/Context 源码 ESLint 与 37 项 scoped code-style 检查通过。

验证数字对应本轮实际完成的运行；工作区同时存在 Runtime、Project 和产品迁移改动，独立后续改动不包含在上述回归数字内。最终复核：

- `bun run check:module-ownership` 全仓通过。
- 74 份现行文档的 Markdown 本地链接全部有效；Agent/Context 源码及现行规范中的 interface 布局引用已完成迁移。
- `git diff --check` 通过，新建 Agent/Context 源文件另行检查尾随空白为零。
- 全仓 `check:code-style` 暂未通过：并行开发中的 RuntimeWorkspaceBinding、RuntimeBootstrap、EffectScheduler 等文件仍有规则问题。本次 Agent/Context 源码的同一组 37 项检查通过；全仓样式状态需要由这些后续改动继续收束。
