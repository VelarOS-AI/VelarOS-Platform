# packages/agent/src 工具面、简化候选与提示词评审

**先说结论：**
- **工具数**：静态工具 20 个，另有 2 类动态工具（MCP、远程主机）。内置 mod 挂了其中 18 个，但生产宿主都不走这份清单。
  - Desktop 自己拼了 18 个：17 个来自内置清单，唯独缺 `context:handoff`，另加 `interaction:confirm`。
  - Workbench 只收了其中 12 个。
  - 结果：**`context:handoff` 在所有生产宿主里都没注册，模型调不到**。
- **收进一个工具文件，主要卡在四处**：
  - 三个工具的 execute 远超"≤4 条语句"：`context:recall` 29 条、`goal:update` 29 条、`plan:update` 23 条。
  - `interaction:confirm` 是手写的工具规格，没走 `defineVelaTool`。
  - 包内有 import 自身根入口（`@velaros-ai/agent`）造成的循环依赖。单独 import `tool-library` 会直接报 TDZ 错，我已复现。
  - 包里没有常量表，说明文字里的数字散写。
- **简化**：
  - 可删 1 个：`context:distill`。
  - 可合并：`goal:get` 并入 `goal:update`，`plan:get` 并入 `plan:update`。
  - 工具内部去重：`tooling:map` 的 `op="read"` 与 `tooling:read` 完全重复；`job:cancel` 与 `agent:dispatch` 的 `interrupt` 重复，二选一。
  - `directive:list` 可并入 `directive:archive`，或降为非常驻。
- **提示词**：冲突 18 条、冗余 19 类、术语歧义 20 类、悬空/过时引用 15 处。模型能看到的纯英文字符串字面量约 190 条。另有两个系统性来源：zod 默认报错全是英文；系统提示词每段的 `<section name>` 用了 17 个英文段名。

路径约定：未写前缀的都相对 `<仓库所在目录>/VelarOS-Platform/packages/agent/src/`；`Desktop:` 与 `Workbench:` 指 `<仓库所在目录>/VelarOS-Desktop/` 与 `…/VelarOS-Workbench/`。

---

## 一、工具面清单

### 1.1 静态模型面工具（20 个）

- **传输名规则**（`tools/ToolIdentity.ts:37-55`）：`namespace:tool` 编译成 `namespace__tool`，例如 `tooling__map`、`job__read_output`。
- **inputReuse**：20 个工具全部没有。agent 包内没有任何工具用 `withToolInputReuse` 或 `inputReuseSourceTools`，只有 system 和 project 包在用。
- **execute 列**：写的是"顶层语句数/含嵌套的总语句数"，是用 TypeScript AST 统计的。

| # | canonical | 类别/分组 | 一句话作用 | 定义 文件:行 | execute 语句 · 委托给谁 | 常驻/保护 | 说明与回执中的英文、裸数字 |
|---|---|---|---|---|---|---|---|
|1|`tooling:map`|agent-control/工具发现|用 find/page/map 查工具页状态与激活路径，另有 op=read 读技能|`tool-library/builtin/Categories.tool.ts:33-80`，外露 schema 在 `ToolSpaceSchemas.ts:397`|2/2 → `Categories.ts:51 runToolSpace` → `ToolSpaceQueries.ts:233/344/483`|Desktop 常驻（`Desktop:src/shared/capabilities/DesktopResidentTools.ts:12`）；bootstrap 阶段保留（`agent/SoloRunPlanPreparer.ts:189-194`）；被强制 toolChoice（`agent/ToolSpaceBootstrapPlanner.ts:197`）；outputInline|示例 query 是英文 "read document"（:64）；参数说明写"ToolOS v2"、"map/batch"（`ToolSpaceSchemas.ts:331,366`）；回执英文见 `ToolSpaceQueries.ts:407/432/438`；schema 裸数字 240/120/12/24/50/8|
|2|`tooling:read`|agent-control（实为读技能）|读 `skill:<id>` 正文；外部技能首次读取弹确认|`Categories.tool.ts:82-109`|1/1 → `ToolSpaceSkillRead.ts:92`、`SkillLoadConfirmation.ts:35`|Desktop 常驻（:13）；技能门控下必留（`SoloRunPlanPreparer.ts:212-218`）；outputInline；Workbench 未注册|无英文；schema 裸数字 180/12|
|3|`tooling:replace`|agent-control|换入/换出工具页，`capability:*` 整类激活并申请授权|`Categories.tool.ts:111-144`|1/1 → `ToolSpaceReplace.ts:210`（约 230 行逻辑）|Desktop 常驻（:14）|参数说明含"AI SDK tools"（`ToolSpaceSchemas.ts:432`）；回执"ContextOS 工具页替换已处理"（`ToolSpaceReplace.ts:435`）；schema 裸数字 180/8/240|
|4|`context:recall`|context|召回历史对话、工具 payload、证据、终端日志、文件旧版本|`tool-library/builtin/ContextRetrieval.tool.ts:20-169`，schema 在 `ContextRetrieval.ts:15`|**16/29**，逻辑全写在 execute 里 → `ctx.conversation.*`、`fileContextFor`|恒常驻：`agent/QueryTurn.ts:383`、`agent/StreamTurn.ts:337` 强制追加，`agent/context/providerRequest/floor.ts:173-180` 断言；Desktop 常驻（:15）；outputInline|示例 reason 英文（:44-46）；回执英文 :60/:69/:73；"Context OS evidence ledger"（`ContextRetrieval.ts:61`）；说明里写"默认 8"、"默认 8000"（:110,:121）|
|5|`context:handoff`|context|请求用户批准，把任务转交到新会话|`ContextHandoff.tool.ts:29-67`|4/5 → `ctx.conversation.requestHandoff`|技能门控下必留（`SoloRunPlanPreparer.ts:217`）；**Desktop 和 Workbench 都没注册**|无；上限 400 是常量，但说明没引用|
|6|`context:distill`|context|（@deprecated）只把事实便签留在回执里|`ContextDistill.tool.ts:54-90`|2/2 内联|不在内置 mod，也不在任何宿主|说明里的数字已用常量模板（:30）|
|7|`directive:list`|context/长期指令|列出会话级长期指令|`ActiveDirectives.tool.ts:17-39`|2/2 → `ActiveDirectives.ts:181`|Desktop 常驻（:16）|无|
|8|`directive:upsert`|同上|写入/更新长期约束（上限 8 条）|`ActiveDirectives.tool.ts:41-128`|2/2 → `ActiveDirectives.ts:192`|Desktop 常驻（:17）|报错英文 `ActiveDirectives.ts:204/214`；schema 裸数字 120/160/1000|
|9|`directive:archive`|同上|按 ids、标题或类型归档约束|`ActiveDirectives.tool.ts:130-179`|1/1 → `ActiveDirectives.ts:233`|Desktop 常驻（:18）|用法（:141）与注意（:143）两句几乎一样；裸数字 20/120/160|
|10|`goal:get`|planning/目标|读当前目标|`Goals.tool.ts:98-125`|4/4 内联|目标模式保护集（`SoloRunPlanPreparer.ts:188`）|无|
|11|`goal:create`|planning|创建活动目标（已有 active 就复用）|`Goals.tool.ts:127-230`|7/9 内联|同上|回执英文 :210；裸数字 2000/12/20|
|12|`goal:update`|planning|改目标、步骤、约束和生命周期|`Goals.tool.ts:232-416`|**22/29** 内联|同上|英文 :338/:410/:411、`Goals.ts:222/299`、`StepRefs.ts:130/166/196`；中文句子里混用半角标点|
|13|`plan:update`|planning/计划|维护界面上可见的执行计划|`Plans.tool.ts:63-279`|**21/23** 内联（`findPlanArtifact`、`readPlanLifecycle` 也写在工具文件 :28-53）|计划模式保护集（`SoloRunPlanPreparer.ts:187`）；bootstrap 阶段保留|`Plans.ts:83` 英文；裸数字 500/12|
|14|`plan:get`|planning|读计划，外加 task、推荐动作、执行建议|`Plans.tool.ts:282-315`|4/4 内联|无|无|
|15|`agent:dispatch`|agent-control/子 Agent|新派、续跑、中断子 Agent（sync/async）|`DispatchAgent.tool.ts:9-107`，schema 在 `DispatchAgent.ts:18`|4/5 → `ctx.dispatchSubAgent`（字段改名写在 execute 里）|Desktop 常驻（:21）；有 isAvailable 门；子 Agent 禁用（`Desktop:src/main/agent/DesktopAgentRuntimePolicy.ts:266`）|示例 5 条英文；说明写"30 分钟"（`DispatchAgent.ts:95`）、"20 条"（:156）；描述 1793 字符，贴着 1800 软预算|
|16|`agent:run_workflow`|agent-control|声明式、有界的多子 Agent 编排，在代码侧归约/投票|`AgentWorkflow.tool.ts:12-83`，schema 在 `AgentWorkflow.ts:216`|2/3 → `ctx.runAgentWorkflow`|有 isAvailable 门；子 Agent 禁用；Workbench 未注册|示例英文（:37,:47），缺省名"Multi-agent workflow"（`AgentWorkflow.ts:219`）；说明写"上限 8"、"32 帽"（:231）、"缺省 3，钳制到 1-6"等（:81/122/152/156）；schema 6828 字符|
|17|`job:read_output`|agent-control/后台作业|读异步子 Agent job 的增量或快照输出|`BackgroundJobs.tool.ts:21-72`|4/6 → `ctx.readBackgroundJobOutput` 加 `BackgroundJobs.ts:145` 格式化|Desktop 常驻（ResidentCommonToolNames :44）|用法里引用英文输出（:38）；回执英文 :65、`BackgroundJobs.ts:151-173`|
|18|`job:wait`|同上|阻塞等待 job 结束，超时返回当前状态|`BackgroundJobs.tool.ts:74-121`|3/4 → `ctx.waitBackgroundJobs`|Desktop 常驻（:43）|回执英文；schema 里 300000/120000/20，execute 又写一遍 `?? 120_000`（:117）|
|19|`job:cancel`|同上|取消 job，中断对应 worker|`BackgroundJobs.tool.ts:123-164`|4/6 → `ctx.cancelBackgroundJob`|无|回执英文 :161|
|20|`interaction:confirm`|interaction|人工确认闸，用户拒绝就终止本次 execution|`kernel/execution/confirmation-tool.ts:30-70`（手写 `ToolContractRuntimeSpec` 加 `renderToolDescription`）|2/2 → `ctx.approval.awaitConfirmation`|不在内置 mod；Desktop 注册并常驻（`Desktop:src/main/tools/collections/builtin/Collection.ts:71`、`DesktopResidentTools.ts:19`）|示例写成了散文，不是 JSON（:45）|

### 1.2 动态工具

| 名字 → 传输名 | 类别 | 定义 | execute | 说明问题 |
|---|---|---|---|---|
|`mcp.<server>:<tool>` → `mcp_<server>__<tool>`（`mcpToolTranslation.ts:76-80`）|默认 `agent-control`（:37）。Desktop 调用时不传 categoryId（`Desktop:src/main/tools/mcp/McpServerManager.ts:134-139`），所以 MCP 工具全部落进控制面类别|`tool-library/mcp/mcpToolTranslation.ts:158-222`|5/11（审批、调用、结果翻译）|描述是中文前缀加服务器原文（多为英文）；`McpClientConnection.ts:98/187/233/291` 英文报错|
|`remote.<host>:<tool>` → `remote_<host>__<tool>`（`remote/RemoteHostService.ts:188-192`）|`remote-host`（`remote/contracts.ts:7`）|`remote/remote-tool.ts:53-109`|3/8|描述是中文前缀加节点原文；`remote-tool.ts:1` import 了本包根入口|

### 1.3 挂载与常驻现状

- **内置 mod**：`mods/BuiltinAgentMod.ts:47-59` 收了 9 个集合共 18 个工具；`collectBuiltinAgentModTools`（:62-73）只做去重。`context:distill` 和 `interaction:confirm` 不在其中。
- **生产宿主不走这份清单**：
  - Desktop 的注释写明"内置载荷绝不重复注册"（`Desktop:src/main/kernel/AgentModRuntime.ts:38-40,571-575`），工具实际来自 `Desktop:src/main/tools/collections/builtin/Collection.ts:2-12,38-77`。那里有 17 个内置工具加 `interaction:confirm`，**没有 `contextHandoffTools`**。
  - Workbench 只收 12 个（`Workbench:src/main/agent/WorkbenchAgentControlTools.ts:98-112`），没有 `tooling:read`、`directive:*`、`run_workflow`、`handoff`、`confirm`。
  - Desktop 的构造级探针（`Desktop:scripts/checks/agentModWiring.mjs:270-283`）只比对 Loader 投影和 `collectBuiltinAgentModTools`，不比对 Collection.ts，所以查不出上面的缺口。
- **常驻与保护的来源分散在五处**：
  - Desktop 常驻清单：`DesktopResidentTools.ts:11-45`
  - Platform 的保护集：`SoloRunPlanPreparer.ts:187-194,212-218`
  - recall 地板：`floor.ts:173-180`，外加 `QueryTurn.ts:383`、`StreamTurn.ts:337`
  - Workbench 按类别整体常驻：`WorkbenchAgentControlTools.ts:122-127`
  - 子 Agent 禁用名单：`Desktop:src/main/agent/DesktopAgentRuntimePolicy.ts:264-277`

### 1.4 工具 → 定义文件 + 实现文件

建议的目标结构：`src/impl/AgentTools.ts` 一个文件（参照 `packages/system/src/impl/SystemTools.ts:293-477` 的分组加挂载写法），常量放 `src/contract/constants.ts`。

| 工具组 | 当前定义 | 当前实现/依赖 | 收拢后 execute 交给谁（建议 impl 类） |
|---|---|---|---|
|tooling:map/read/replace|`tool-library/builtin/Categories.tool.ts`|`Categories.ts`、`ToolSpaceSchemas.ts`、`ToolSpaceQueries.ts`、`ToolSpaceSearch.ts`、`ToolSearchTerms.ts`、`ToolReadDetails.ts`、`ToolSpaceActivation.ts`、`ToolSpaceReplace.ts`、`ToolSpaceSkillRead.ts`、`SkillLoadConfirmation.ts`；`tools/tool-space-resolver.ts`、`tools/discovery-availability.ts`|`AgentToolSpaceOperations`（find/page/map/replace）、`AgentSkillReader`|
|context:recall|`ContextRetrieval.tool.ts`（含 `presentHistoricalFile` :13-18）|`ContextRetrieval.ts`、`agent/context/retrieval/ContextRetrievalService.ts`、`agent/context/resources/FileContextCoordinator.ts`、`FileSnapshotArchive.ts`|`AgentContextRecallOperations`，把 :57-168 整段下沉|
|context:handoff / distill|`ContextHandoff.tool.ts` / `ContextDistill.tool.ts`|宿主 `conversation.requestHandoff` / 无|handoff 保持一行委托；distill 删除|
|directive:*|`ActiveDirectives.tool.ts`|`ActiveDirectives.ts`|`AgentDirectiveOperations`|
|goal:*|`Goals.tool.ts`|`Goals.ts`、`StepRefs.ts`、`agent/SoloGoalLifecycle.ts`|`AgentGoalOperations`，接收 :112-124、:197-229、:329-415|
|plan:*|`Plans.tool.ts`|`Plans.ts`、`StepRefs.ts`|`AgentPlanOperations`|
|agent:dispatch / run_workflow|`DispatchAgent.tool.ts` / `AgentWorkflow.tool.ts`|`DispatchAgent.ts`、`AgentWorkflow.ts`；`kernel/dispatch/SubAgentDispatcher.ts`、`agent/runner/AgentWorkflowCoordinator.ts`、`workflow/AgentWorkflowRuntime.ts`|一行委托；dispatch 的字段映射下沉|
|job:*|`BackgroundJobs.tool.ts`|`BackgroundJobs.ts`、`kernel/background-jobs.ts`|`AgentBackgroundJobOperations`，负责可用性守卫和格式化|
|interaction:confirm|`kernel/execution/confirmation-tool.ts`|`tool-contract` 的 ApprovalPort|迁进工具文件，改用 `defineVelaTool`|
|能力声明|`Capabilities.ts`（10 个常量）|—|放进工具文件，或 `contract/constants.ts`|
|MCP / 远程|`mcpToolTranslation.ts` / `remote/remote-tool.ts`|`mcpApprovalArguments.ts`、`mcpCallResult.ts`、`McpClientConnection.ts` / `RemoteHostService.ts`|动态工厂放进 impl 类，工具文件登记工厂；或在门禁里登记为动态例外|
|分组与挂载|`mods/BuiltinAgentMod.ts:47-59`|—|收进工具文件末尾|
|宿主端口|`tool-library/KernelToolContext.ts:93-166`（约 45 个成员）|`tool-library/context/*.ts`|工具实际只用约 22 个（grep `ctx.*` 统计）：activeContext、codingSession、conversation、approval、interaction、skills、dispatchSubAgent、runAgentWorkflow、job 三个端口、requestToolCategoryAccess、listToolCategories、getCurrentVisibleToolNames、describeToolInputSchema 等。按标准应拆出只含这些方法的 hostPort|

**合成一个文件前必须先解决的阻碍：**
1. **import 循环**：`tool-library/builtin/ToolSpaceSchemas.ts` → `tools/index.ts` → `tools/Executor.ts` → `kernel/index.ts` → `kernel/background-jobs.ts:31`（`import … from '@velaros-ai/agent'`，包内自引用根入口）→ `index.ts` → `mods/BuiltinAgentMod.ts:53`。直接 import `tool-library` 会抛 `Cannot access 'categoriesTools' before initialization`。`agent/*` 下多处以及 `remote/remote-tool.ts:1` 也在自引用。
2. **重逻辑下沉**：`context:recall`、`goal:update`、`plan:update`、`goal:create` 的 execute 要搬进 impl 类。
3. **数字进常量表**：约 60 个裸数字待登记。其中"30 分钟"是宿主可调的 `agent/ExecutionLimits.ts:60`，"32 帽"来自 `kernel/dispatch/SubAgentDispatcher.ts:274`，说明里写死就成了第二本账。另外 dispatch 的 `attachments` 上限是 20，workflow 是 12，两处不一致。

---

## 二、简化候选（按"别的工具替代得了、只剩仪式感才删"判）

| 工具 | 判定 | 理由 | 风险 / 谁在用 |
|---|---|---|---|
|`context:distill`|**删除**|自己标了 @deprecated（`ContextDistill.tool.ts:92`）；不在内置 mod，Desktop 2026-09-08 已移除（`698d3a1ed`）；容量治理已经自动化；`ContextEpochRequestToolName`（`agent/context/residency/ContextGovernanceSession.ts:52`）是没人用的死常量|npm 根入口导出 `contextDistillTools`，删除属于入口变更，需人拍板；5 个测试要改（`test/contextDistillTool.test.ts`、`contextAutomaticToolSurface.test.ts`、`builtinToolCapabilityTruth.test.ts` 等）；UI 渲染历史记录（`packages/ui/.../toolPresentationCatalog.ts:35`、`toolCallSummary.ts:193-201`）要保留|
|`goal:get`|**合并进 `goal:update` 的空调用**|`goal:update` 的说明已写"都不传则视为读取"（`Goals.tool.ts:261`）；活动目标每轮都以 active-task 块注入（`agent/ProviderTurnRequestHelper.ts:360-376`）|要先把"没有目标时空调用也抛错"（:337-339）改成返回 `status:'none'`；引用方：`SoloRunPlanPreparer.ts:188`、`Desktop:src/main/agent/unattended/UnattendedTaskToolPolicy.ts:99`、UI 目录、`tests/ui/toolTargetSummary.test.ts:104`|
|`plan:get`|**合并进 `plan:update` 的空调用**|空调用已等价（`Plans.tool.ts:81,199-206`）；计划预览每轮都在系统提示里（`prompts/segments/task.ts:17-24`）|它多出的 task、recommendedAction、executionAdvice 三个字段要先确认还有没有价值（Workbench 本身没有执行账）；`coding/tool-dedupe.ts:6-11` 会拦截重复的 `plan:update`，合并后要放行空调用；引用方：`UnattendedTaskToolPolicy.ts:98`、Workbench plansTools、`test/planLifecycle.test.ts:126,219`|
|`tooling:map` 的 `op="read"`|**删掉这一路**（`tooling:read` 保留）|与 `tooling:read` 完全同一路径：`ToolSpaceSchemas.ts:284-291,308-317,390-391` → `readRequestedSkillPages`|技能索引、`SkillGateAlwaysKeptToolNames`、`PromptState.ts:272` 都认 `tooling:read`，所以留 read 删 op|
|`job:cancel` 与 `agent:dispatch.interrupt`|**二选一**|后台 job 只有子 Agent 一种来源（`kernel/dispatch/SubAgentDispatcher.ts:925-928`）。两条路径都是中止 worker（:1026-1051 与 :1023），模型得同时记住 thread_id 和 job_id|interrupt 的测试：`test/agentDispatchInputContract.test.ts`、`subAgentThreadRetention.test.ts`；job:cancel 在 `DesktopAgentRuntimePolicy.ts:275`、`WebConversationToolService.ts:41`。建议保留 `job:cancel`，给 dispatch 瘦身|
|`directive:list`|**合并或降级**|活动长期指令每轮都以 pinned-evidence 注入（`ProviderTurnRequestHelper.ts:378-387`，最多 8 条，与上限一致）；archive 支持按 title/type 匹配，不需要 id|Desktop 让它常驻，测试 `Desktop:tests/.../DesktopAgentRuntimePolicy.test.ts:205-207` 有断言。可以并进 archive（未命中时回显当前列表），或至少降为非常驻|
|`context:handoff`|**保留，但要接线**|独特能力：用户批准的会话转交；Desktop 的 renderer 和治理层都在等它（`Desktop:src/main/agent/context/ContextGovernanceWiring.ts:172`）|现状是没有任何生产宿主注册，`prompts/segments/runtime.ts:69-72` 那句永远不会出现。要么在 Desktop Collection.ts 和 Workbench 注册，要么明确承认未上线|
|`goal:create`|保留，改说明|模型自主建目标和界面目标卡依赖它|显式目标模式下运行时已经自动建好目标（`agent/SoloLoop.ts:501-504`），说明里的"目标模式刚开始时创建"已经过时（见 3.1 C6）|
|`agent:run_workflow`|保留|有界编排和代码侧 filter/dedupe/majority_vote，多次 dispatch 替代不了|只有 Desktop 注册|
|`job:wait`|保留，讲清分工|模型在一轮中间要按 job 定点等待|与收尾自动停泊（`agent/SoloBackgroundCompletionGate.ts:43-90`）部分重叠，说明没提停泊（见 C11）；可以和 `read_output` 合成一个按 action 分支的工具（可选）|
|`job:read_output`、`agent:dispatch`、`context:recall`、`tooling:replace`、`directive:upsert/archive`、`goal:update`、`plan:update`、`interaction:confirm`、MCP、远程|保留|各有唯一能力（recall 还受 floor 强制）|`interaction:confirm` 要迁进工具文件；MCP 默认类别该改（混进了控制面）|

**工具发现/激活这一块的"仪式感"：**
- 现在只剩 `tooling:map/read/replace` 三个模型面工具。"activate/schemas/skill read/search"已经是内部模块，旧的 schema 预览已退役（`ToolSpaceSkillRead.ts:17-20`、`ToolReadDetails.ts:10-15`）。
- 真正的仪式在运行时：bootstrap 会强制 toolChoice 到 `tooling:map`（`ToolSpaceBootstrapPlanner.ts:189-201`），同时文件里自己写着工具已经"填满预算常驻"。建议复评强制发现。
- `capability:*` 整类激活和 `tool:*` 换入会走到同一个结果：`tool:*` 缺授权时会自动申请类别（`ToolSpaceReplace.ts:291-317`），所以整类激活只剩"批量开一类"的价值，属于说明负担。
- 工具页卡片太胖：同一个状态用 `availability`、`toolOsState`、`nextAction`、`activation.method`、`access.*`、`resident`、`schemaState` 七个字段各表达一遍（`ToolSpaceQueries.ts:144-169`）。其中 `schemaState` 恒为 visible（`tools/discovery-availability.ts:77-84`），`nextAction` 的 `describe` 值从不产生。replace 回执里 `recommendedPageIn`、`recommendedTools`、`userActionHint` 恒为空，`skippedPages` 与 `unavailableTargets` 重复（`ToolSpaceReplace.ts:404-413`）。可以瘦身。
- 结构上可议、需人拍板：`goal.steps` 与 `plan` 是两本步骤账（`Goals.tool.ts:148,180,301` 明写"不替代 plan:update"），模型在目标模式里要双写。

---

## 三、提示词问题清单

### 3.1 冲突与优先级不清

| # | 位置 A 原文 | 位置 B 原文 | 建议 |
|---|---|---|---|
|C1|`ToolSpaceBootstrapPlanner.ts:153`「不要在未确认工具页状态、依赖和 schema 前直接用现有工具凑答案」|`Categories.tool.ts:40`「已在当前工具列表中提供完整参数的工具可直接调用」；`runtime.ts:54`「…以本轮 schema/description 为准」|删掉 A 这句，改成"只查缺失能力"|
|C2|`Goals.tool.ts:261`「所有字段都不传则视为读取当前目标、不报错」|同文件 :337-339 没有目标时抛「No active goal exists. Use goal:create first.」|空调用在没有目标时返回 `status:'none'`|
|C3|`Goals.tool.ts:257`「status=complete…不用逐个 complete_step」|`Goals.ts:299`「…Use complete_step, skip, or update failed steps first」|报错改中文，只指向 failed 步骤|
|C4|`Plans.tool.ts:117-120` 与 `Goals.tool.ts:34-36`「稳定步骤 ID；已有步骤可复用」|`Plans.tool.ts:77`「步骤没有 id,别自造 "step-1"」、:164、`Goals.tool.ts:311`；而计划回执里的步骤其实都带 id（`protocol/types/execution.ts:111`、`StepRefs.ts:55`）|统一口径：说清哪种步骤有 id，schema 与说明一致|
|C5|`Goals.tool.ts:103`「…或进入受阻审计」|:258 与 `SoloFinishingGate.ts:162`「不需要等待多轮审计」；而 `SoloGoalLifecycle.ts:130-152` 仍在累计 `blockedAuditTurns`|删掉"受阻审计"这个概念，或删掉计数|
|C6|`Goals.tool.ts:139`「目标模式刚开始且尚未存在活动目标」；`SoloFinishingGate.ts:159`「如果还没有目标，先调用 goal:create」|`SoloLoop.ts:501-504` 在显式目标模式下自动建目标，缺省目标是'完成当前用户目标'，所以"缺目标"分支走不到|改成"非目标模式下自主建目标"，删掉收尾门那一行|
|C7|`Goals.tool.ts:156`「重复创建是幂等读取，不会覆盖当前目标」|:204 只在 active 时复用；暂停的目标会被同 id `active-goal` 覆盖（`Goals.ts:13,176`）|说明写清"暂停的目标会被替换"，或改成拒绝|
|C8|`BackgroundJobs.ts:30,70`「返回里会带「命中 K/N 行」」|实际输出 `:164` 是「[filter matched K/N line(s)…]」，`BackgroundJobs.tool.ts:38` 引用的也是英文|回执改中文，说明与回执同源|
|C9|`control-plane/RuntimeRunPlanner.ts:255-256`「先读取对应工具页确认依赖和 schema」|`Categories.tool.ts:91`「不要用 tooling:read 读工具页」；而且 'read-page' 这个动作从不产生（:143-155）|删掉这个分支|
|C10|`Plans.tool.ts:75`「用户明确选择计划模式…按该要求等待确认」|没有任何提示词段读 `userRequestedPlan`（`PromptState.ts:242` 赋了值但没人消费）；`execution-modes/ExecutionModeRegistry.ts:41` 却声称"提示词面由它驱动"|补一个 plan-mode 提示词段，或删掉这句|
|C11|`DispatchAgent.tool.ts:27`「mode=async…之后用 job:read_output/job:wait 收束」|运行时收尾会自动停泊并被唤醒（`SoloBackgroundCompletionGate.ts:43-53`、`kernel/background-jobs.ts:606`「请读取该任务的 job 输出后再决定下一步」）|写明"可以直接结束本轮，等通知"|
|C12|用户附加提示词在 `prompts/catalog.ts:177-185`（tier runtime，priority 10_000）|注册表先按 tier 排序（`prompts/registry.ts:308-312`），skill 段（`prompts/segments/shared.ts:183-205`）总排在用户附加之后|定下用户附加是否要排最后|
|C13|`SoloTurnWindDown.ts:22`「请立即停止调用工具，基于现有进展给出结论」|目标模式下 `SoloFinishingGate.ts:158`「必须继续推进，不能直接结束本次回复」|收尾提醒里补一句"目标模式先 goal:update blocked"|
|C14|`coding/tool-dedupe.ts:95-96` 对重复 `tooling:read` 说「若工具页已换入，请等待下一轮…」|`tooling:read` 读的是技能，不是工具页；dedupe 还会拦 `plan:update` 的合法空读（`Plans.tool.ts:81`）|按工具分文案，空调用放行|
|C15|`ToolSpaceActivation.ts:14-15`「本文件不认识任何具体能力」|:162-167、:355-363 写死了 `interaction:show_action_cards`，这个工具 Workbench 没有|改由注入描述符提供|
|C16|`tool-contract/ToolDescription.ts:71`「模型面描述永不压缩」|`compactStructuredToolDescription`（:365-391）被 `Desktop:src/plugins/chatgpt/main/runtime/WebConversationToolService.ts:102-104` 截到 280 字符|定一个口径|
|C17|`context:handoff` 说明和 `runtime.ts:69-72` 都写了|任何宿主都没注册这个工具|见第二节|
|C18|`catalog.ts:35`「简单任务直接完成」|`SoloProcessUpdateCadence.ts:17-19` 连续两个纯工具回合就提醒，不看任务大小|提醒加任务复杂度条件|

### 3.2 冗余（同一规则写在多处）

| # | 规则 | 出现位置 |
|---|---|---|
|R1|工具状态 → 下一步怎么做（整个阶梯）|`Categories.tool.ts:57`；`ToolSpaceActivation.ts:236-261,285-375`；`ToolSpaceQueries.ts:421-446`（stateLegend）；`tools/tool-space-recovery.ts:20-23`；`tools/tool-space-resolver.ts:309-320`；`ToolSpaceReplace.ts:184-205`|
|R2|换入后下一轮才生效|`Categories.tool.ts:121,134`；`ToolSpaceQueries.ts:307,376,638`；`ToolSpaceActivation.ts:195,200,244,324,330`；`ToolSpaceReplace.ts:190`；`tool-dedupe.ts:96`；`tool-space-recovery.ts:22`|
|R3|失败参数复用|`runtime.ts:58`；`tools/ToolArgsSchemaValidator.ts:284`；`ContextRetrieval.tool.ts:39`；`tools/recovery/ToolInputReuse.ts:11,37-38`（英文）；`tools/recovery/ExecutionProgress.ts:54`|
|R4|上下文自动整理|`runtime.ts:59`；`agent/context/residency/dashboard.ts:78`（英文）；`ContextHandoff.tool.ts:36,40,50`；`runtime.ts:71`；`ContextDistill.tool.ts:87`|
|R5|优先用 thread_id 续跑子 Agent|`runtime.ts:103-104`；`DispatchAgent.tool.ts:29-30`；`DispatchAgent.ts:95`|
|R6|agent_name 用英文代号|`DispatchAgent.tool.ts:32` 与 `DispatchAgent.ts:29`|
|R7|Markdown / Widget / HTML 该用哪个|`catalog.ts:137-138` 与 :169-170；:152 与 :170（三段同时生效时重复出现）|
|R8|当前状态原则、过程沟通|`catalog.ts:32` 与 :33；:34 与 :35，再加 `SoloProcessUpdateCadence.ts:17-19`|
|R9|directive:archive 的边界|`ActiveDirectives.tool.ts:141` 与 :143|
|R10|长任务才建目标|`Goals.tool.ts:137-138,142,146`|
|R11|不要自造步骤 id|`Plans.tool.ts:77,164`；`Goals.tool.ts:256,311`；`StepRefs.ts:166`|
|R12|防循环：三套机制，阈值和语言各不相同|`kernel/tool-loop-guard.ts:80`（2 次）、:116（3 次）；`ExecutionProgress.ts:54`（3 次）；`tool-dedupe.ts:89-96`|
|R13|恢复提示两套几乎一样的文本|`agent/QueryLoop.ts:905-912` 与 `StreamTurn.ts:760-767`；`QueryTurn.ts:696-710` 与 `StreamTurn.ts:806-841`|
|R14|blocked 不必等多轮审计|`Goals.tool.ts:258` 与 `SoloFinishingGate.ts:162`，两处同一句|
|R15|filter 的解释|`BackgroundJobs.tool.ts:37,92`；`BackgroundJobs.ts:30,70`|
|R16|tooling:read 不读工具页|`Categories.tool.ts:91`；`ToolSpaceSchemas.ts:255`；`ToolSpaceSkillRead.ts:125`|
|R17|回执里双份数据|`Plans.tool.ts:269-272`（同时回 `plan` 和 `steps`）；`Goals.tool.ts:401-404`；`ToolSpaceReplace.ts:404-413`|
|R18|schema 失败时的 nextActions|`ToolArgsSchemaValidator.ts:283-285` 与 `ExecutionPolicyFailures.ts:181-182` 叠加，一次失败给 5 条|
|R19|收尾停轮提示|`SoloTurnWindDown.ts:21-23` 与 `QueryLoop.ts:306-313`，两套措辞|

### 3.3 歧义、术语不一与中英混杂

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
|A1|上级 Agent 有 7 种叫法：主 Agent、父 Agent、上级、上游角色、主控、上级主 Agent、parent agent|`runtime.ts:101-105`、`DispatchAgent.ts:50,104`、`QueryLoop.ts:310,925-927`、`agent/LoopRuntime.ts:190`、`QueryLoop.ts:907`|统一为"主 Agent"|
|A2|子 Agent 有 4 种叫法：子 Agent、sub-agent、子智能体、worker|`DispatchAgent.tool.ts:13`、`sub-agent/SubAgentResultBuilder.ts:62`、`SubAgentDispatcher.ts:1016-1022`、`BackgroundJobs.tool.ts:139`|统一为"子 Agent"|
|A3|可见工具面有多个名字：当前工具列表、本轮 AI SDK tools、可见工具空间、动态工具空间、ContextOS 工具空间|`Categories.tool.ts:40`、`ToolSpaceActivation.ts:195,237,287`、`ToolSpaceSchemas.ts:432`、`ToolSpaceBootstrapPlanner.ts:150`、`tools/tool-space-resolver.ts:309-311`|定一个词，去掉实现名|
|A4|状态词两套：`availability` 的 visible 对应 `toolOsState` 的 resident；loadable 在两套里语义不同|`tools/discovery-availability.ts:5-21,103-110`；`Categories.tool.ts:57,60`（"优先读 toolOsState"）与 `ToolSpaceActivation.ts` 的 method|模型面只保留一套|
|A5|内部术语直接给模型看：ContextOS、Context OS、ToolOS v2、evidence ledger、CapabilityScopePolicy、上下文保护区、折叠桩|`ToolSpaceSchemas.ts:108,160,204,331`、`ContextRetrieval.ts:61`、`Categories.tool.ts:70`、`ActiveDirectives.tool.ts:21`、`ContextRetrieval.tool.ts:33`|换成行为描述|
|A6|"任务账本"没定义|`prompts/segments/task.ts:31`|写明指的是 goal、plan 还是 steps|
|A7|作用域词混杂：计划说 "execution"，目标说 "session"，没解释计划何时重置|`Plans.tool.ts:67,286,291`；`Goals.tool.ts:102,136,242`；`confirmation-tool.ts:44,47`|说明计划随执行结束|
|A8|注入信封格式不统一：`[系统]`、`[system]`、`[主控 relay 引导]`、无前缀英文、`<sys_note>`、`<environment-context>`、`[context-dashboard]`、`[ContextOS retained context]`、`<agent-surface-context>`、`[system prompt · dynamic layer (current turn)]`|`SoloTurnWindDown.ts:21`、`SoloProcessUpdateCadence.ts:17`、`RuntimeRunPlanner.ts:231`、`QueryLoop.ts:926`、`agent/history/internalMessages.ts:26`、`agent/run-context/TurnContextFormat.ts:7`、`dashboard.ts:26`、`retainedContextStage.ts:52`、`protocol/product-surface.ts:102`、`StreamTurn.ts:79`|定一种前缀规范|
|A9|Skill 与"技能"混用|`skills/AgentSkillRepository.ts:332-349` 对比 `Categories.tool.ts:88-99`|统一中文|
|A10|完成态拼写不一：目标用 `complete`，计划和步骤用 `completed`|`Goals.tool.ts:32` 对比 `Plans.ts:37`|统一为 completed|
|A11|计划入参字段叫 `step`，回执叫 `title`；预览里状态是中文（`PromptState.ts:388-397`），回执里是英文|`Plans.tool.ts:123`、`StepRefs.ts:61-69`|统一字段名|
|A12|说明里写"bash 轮询"，但系统里没有 bash 工具|`BackgroundJobs.tool.ts:49`|改成 `system:run`|
|A13|"系统任务工具"指代不清|`BackgroundJobs.tool.ts:85,134`|点名 `system:list-tasks`|
|A14|"后台任务"撞名：`system:list-tasks`（`packages/system/src/impl/SystemTools.ts:227`）和子 Agent job 通知（`kernel/background-jobs.ts:400,606,638`）都叫后台任务|同左|job 通知改称"子 Agent 作业"|
|A15|"宿主提供的能力发现接口"含糊|`ToolArgsSchemaValidator.ts:285`|点名 `tooling:map`|
|A16|中文句子里夹半角标点|`Goals.tool.ts:254-258,309-312`、`Plans.tool.ts:76-81,162-166`、`ContextRetrieval.tool.ts:40`|统一全角|
|A17|"强制流程"分节塞了非强制的说明（精简模式下只保留这一节）|`Categories.tool.ts:51-58,94,122-126`|只放必须遵守的流程|
|A18|对模型暴露架构说明|`DispatchAgent.tool.ts:62`「跨作用域派发属于具体能力，由能力包注册专用工具并注入端口」|删掉|
|A19|MCP 工具默认进 `agent-control`，和工具发现、派子 Agent 同类|`mcpToolTranslation.ts:37`|单独设一个 mcp 类别|
|A20|`interaction:confirm` 的示例是散文|`confirmation-tool.ts:45`|改成 JSON 示例|

### 3.4 悬空与过时引用

| # | 原文与位置 | 事实 |
|---|---|---|
|S1|`ContextRetrieval.tool.ts:49`「优先阅读 [置顶执行证据]/[动态检索句柄] 摘要」|这两个标记已没有生产者（`agent/history/contextOSMessage.ts:18-22`）；实际的保留块用的是 `[ContextOS retained context]`|
|S2|`Categories.tool.ts:95` 与 `ToolSpaceSkillRead.ts:125`「「可按需读取的技能」索引」|全仓库没有这个标题，实际标题是「# 命中 Skill」（`AgentSkillRepository.ts:332`）|
|S3|`ToolSpaceSchemas.ts:65`「read：读取指定工具页元数据」、:366「map/batch 模式」|前者是死描述且语义已相反；batch 模式不存在|
|S4|`RuntimeRunPlanner.ts:255` 的 read-page 分支|这个动作从不产生|
|S5|reminders 调度器没有任何 producer|Desktop `src/main/execution/Runtime.ts:478-482` 和 Workbench 都没传 `reminderProducers`（接收处 `agent/runner/AgentRunner.ts:212`）。`coding/AutoVerification.ts:164` 引用的 `reminders/producers.ts` 已不存在；:227 引用的是已删除的 `summarize_current_dev_environment`|
|S6|`ExecutionModeRegistry.ts:27-29` 写「goalMode: … hasActiveGoal」|`PromptState.ts:243` 只认显式模式|
|S7|提示词快照里算了但没人读的字段：recentToolFailures、currentExecutionAdvice、hasCompactedContext、userRequestedPlan、canUpdatePlan、autoPromptFeatureLabels、requestableToolCapabilityCategories、availableSkills|`PromptState.ts:238-262`|
|S8|`SoloGoalLifecycle.recordSuccessfulCompletion`（:110-120）|没有调用方，注释也和"自动收尾步骤"的语义冲突|
|S9|`kernel/final-readiness.ts:9` 的 `missing-verification`|从不产生（:94-95）|
|S10|`tools/ExecutionPolicy.ts:803-815` 的计划模式工具门|恒放行|
|S11|`ToolSpaceSchemas.ts:221`「默认 12…」|外露 schema 不用这一份，模型看不到|
|S12|`ExecutionPolicy.ts:696-703` 的注释|挂在 `supportsInputReuse` 上，实际说的是 `shouldAbortSiblings`|
|S13|`ContextGovernanceSession.ts:52` 的 `ContextEpochRequestToolName`|没人用|
|S14|`ToolSpaceReplace.ts:406-413`|恒为空的字段|
|S15|`AgentSkillRepository.ts:337-349` 让读技能时调用 `tooling:read`|若 Workbench 注入技能，它并没有注册这个工具（需核实）|

### 3.5 模型看得到的纯英文句子（违反"统一中文"）

- **统计方法**：用 TypeScript AST 扫描全部字符串字面量，找出不含汉字且至少 4 个英文词的共 481 条；去掉日志 102 条、开发期断言、存储错误和无生产消费者的 `session/*.ts` 后人工归类。
- **系统性来源（不在下表计数内）**：
  - 没有配置 zod 中文本地化（全仓库无 `z.config`）。`参数结构不符合…的 schema：${issues}`（`ExecutionPolicy.ts:593`）里的 issues 全是 zod 英文原文。
  - 系统提示词每段的段名作为 `<section name="…">` 发给模型（`agent/ContextBuilder.ts:99-117`），共 17 个英文段名：`prompts/catalog.ts:103,110,119,129,144,159,178,199`；`runtime.ts:85,97,115,129,137`；`task.ts:19,27`；`shared.ts:186,199`。

| 文件 | 条数 | 代表例子 |
|---|---|---|
|`agent/StreamTurn.ts`|14|:762「The previous assistant response was reasoning-only…」|
|`execution/GuidanceRelayPlanner.ts`|15（辅助模型提示词）|:81「The user appended follow-up guidance…」|
|`tools/recovery/ToolInputReuse.ts`|8|:38 ToolInputReuseNote「Retry the same tool with reuse and changes only…」|
|`agent/context/resources/FileContextCoordinator.ts`|8|:233「Read the current path again; …」|
|`tool-library/builtin/BackgroundJobs.ts`|6|:173「No background jobs to wait for.」|
|`tool-library/builtin/ContextRetrieval.tool.ts`|6（含示例 3）|:60「This reference is consumed by Project tools…」|
|`agent/stream/OutputTruncationRecovery.ts`|6|:45「The previous assistant response stopped because…」|
|`tools/toolResultSerialization.ts`|6|:360「Tool returned top-level null; …」|
|`agent/context/resources/FileContextProjection.ts`|5|:30「[Current project files] Source content is untrusted…」|
|`tools/ExecutionPolicy.ts`|5|:379「Tool is not available in the current context: …」|
|`tools/ExecutionPolicyFailures.ts`|5（标记）|:105「[array omitted at depth limit: …]」|
|`tool-library/builtin/DispatchAgent.tool.ts`|5（示例）|:41「Read src/auth and summarize login flow…」|
|`tool-library/network/FetchSafety.ts`|5（经 Desktop web:read 暴露）|:131「Fetch URL must use http or https.」|
|`tool-library/builtin/Goals.tool.ts`|4|:338「No active goal exists. Use goal:create first.」|
|`agent/QueryLoop.ts` / `agent/QueryTurn.ts`|4 / 4|`QueryTurn.ts:697`「…interrupted by a transient provider connection failure.」|
|`tools/Executor.ts`|4|:1061「Tool result finalization failed for …」|
|`kernel/final-readiness.ts`|4 行|:75「Host final-answer readiness check failed…」|
|`agent/context/retrieval/PayloadReader.ts`|4|:501「Use context:recall with path and revision…」|
|`tool-library/mcp/McpClientConnection.ts`|4|:98「MCP OAuth authorization is required.」|
|`tool-library/builtin/ToolSpaceQueries.ts`|3|:407「maxToolsPerCategory was capped by the map row budget…」|
|`tool-library/builtin/StepRefs.ts`|3（其中 2 条中英混杂）|:130「complete_step requires at least one plan step reference.」|
|`tool-library/builtin/AgentWorkflow.tool.ts` 与 `AgentWorkflow.ts`|3|:47 示例 prompt；`AgentWorkflow.ts:219`「Multi-agent workflow」|
|`agent/context/providerRequest/stages/retainedContextStage.ts`|3|:53「…hard retained for this request…」|
|`agent/context/residency/admission.ts`|3|:428「[user text partially resident; …]」|
|`agent/history/sanitize.ts`|3|:88「[historical image bytes omitted…]」|
|`kernel/tool-loop-guard.ts`|2|:116「The same tool failure batch failed 3 times…」|
|`tool-library/builtin/Goals.ts` / `ActiveDirectives.ts` / `BackgroundJobs.tool.ts`|2 / 2 / 2|`ActiveDirectives.ts:214`「Context protection area already contains …」|
|`tools/tool-space-resolver.ts` / `tools/historyPreviewPlaceholder.ts` / `agent/runner/AgentRunner.ts` / `agent/runner/AgentWorkflowCoordinator.ts`|2 / 2 / 2 / 2|`tool-space-resolver.ts:268`「The injected capability policy denied…」|
|各 1 条|—|`agent/control-plane/RuntimeRunPlanner.ts:231`（外加 :261 中英混杂）、`agent/context/residency/dashboard.ts:78`（外加整行 key=value 英文账目）、`agent/context/residency/projection.ts:435`、`kernel/tool-output-store.ts:230`、`agent/context/resources/FileSnapshotArchive.ts:125`、`agent/context/retrieval/search/Ranking.ts:364`、`agent/history/repair.ts:41`、`agent/LoopRuntime.ts:431`、`protocol/product-surface.ts:103`、`tools/recovery/ExecutionProgress.ts:54`、`tools/toolInputHistoryProjection.ts:90`、`tools/capability-registry.ts:54`、`tools/ToolArgsSchemaValidator.ts:227`、`tool-library/builtin/Plans.ts:83`、`Categories.tool.ts:64`（示例）、`SoloProcessUpdateCadence.ts:17`（`[system]` 前缀）|

**另外两点：**
- 用户看得到、模型看不到的英文：`agent/stream/recorder.ts:39-51,162-163`（6 条）、`mods/VelarModArchiveImporter.ts`（31 条，mod 导入界面的报错）。
- **翻译前要先解耦**：`tools/ExecutionPolicy.ts:769` 靠文本正则 `/not available|不可使用|不可用/` 给失败归类，违反"失败按错误码判断"的规则。应先改成按错误码判断，再翻译 :379/:433/:542 那几条英文，否则改文案会改变归类结果。

整个过程只读：没有修改仓库文件，也没有 git 操作；统计脚本和中间结果都放在会话草稿区（`…/scratchpad/`）。