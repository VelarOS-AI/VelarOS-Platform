分析完成，全程只读，没有改任何文件，也没有提交。行号以 Platform HEAD `1ebe2f6` 为准。分析期间另一个实例一直在提交：HEAD 从 21fcb91 走到 1ebe2f6，其中 `3489fa6` 改了 `src/agent/LoopRuntime.ts`，之后 agent 目录没再变。

路径约定：`src/…` 指 `<仓库所在目录>/VelarOS-Platform/packages/agent/src/…`；`Platform/`、`Desktop/`、`Workbench/` 指 `<仓库所在目录>/` 下的三个仓。

## 结论速览

- **门禁已禁的词确实清零了。** browser、workspace、workbench、memory、knowledge、computer、工作区、浏览器、记忆在 src 里命中为 0，基线为空。泄漏全部集中在门禁没禁的 project、system:、office、html-artifact/widget、Desktop 宿主 DTO、厂商名和角色 id 上。
- **最大的一块是 Project 的“当前源码视图”整条链**（约 1,100 行）：`projectReadSerialization`、`context/resources/*`、恢复投影、`context:recall` 的 path/revision。它写死在每次向模型发送请求的主链上。
- **第二块是 `coding/*` 加 `CodingSessionTracker` 里的“变更-验证账本”。** 这是 Project 语义，而且生产中基本空转：三个仓里没有任何人注入 activityCategories、validationInterpreters、reminderProducers。
- **厂商知识有 6 处。** 其中 `PromptCache` 和 `raw-text` 与 `@velaros-ai/model` 里已有的实现几乎逐行重复。
- **有一个新回归：** `3489fa6` 在 `LoopRuntime` 里写死了 `project` 端口（`system` 端口的类似写死之前就有）。门禁不禁 project/system，所以放行了。

---

## 一、必须搬走（P0）

### P0-1　Project 源码视图 / 文件上下文整条链

**写死的知识：**
- **`src/tools/projectReadSerialization.ts`**（L7-9, 12-38, 129-156）
  - 按字符串识别 `kind:'project-source-window'`，这个类型定义在 `Platform/packages/project/src/types/source-window.ts:6`。
  - 识别 Project 读结果的旧形状：`content` + `snapshot{path,revision}` + `contentFormat:'line-numbered'` + `range` + `continuation`。
  - 生成 `continuation.baseRevisions`（Project 编辑协议）。
- **`src/agent/context/resources/FileContextProjection.ts`**
  - L29-30：写死 `'[Current project files]'` 头，以及 “project:read … fileRef” 的指令文案。
  - L50、86、132、144、154：`'project-source-window'`。
  - L136、166、176-186：`project:read`、`'project:'` 前缀，以及 project:read 结果形状（rootPath、files、editTarget）。
  - L157-158、179-180：file-view-receipt / file-read-receipt 的文案。
- **`src/agent/context/resources/FileContextCoordinator.ts`**
  - L229、237：kind 判断。
  - L269：识别 `[Current project files]` 头。
  - L318：`startsWith('project:')`。
  - L356-426：解析 project:read 结果形状，包括去掉 `line-numbered` 的行号前缀。
  - L551：“current project policy” 文案。
  - L630-639 `forkFileContext`：用 7 个 `project:*` 工具名判断子 Agent 能否读源码。
- **`src/agent/context/resources/PrivateFileRecords.ts:1-4`**：`'__project_file_reference__'`、`'__project_edit_target__'`。这两个记录名是 Project 自己的（`project/src/utils/agent/file-refs.ts:10`、`edit-target.ts:11`），在 `retrieval/PayloadReader.ts:500,644` 和 `retrieval/IndexBuilder.ts:83` 里被用来屏蔽。
- **`src/tools/recovery/TransientRecoveryProjection.ts:7-8`**：`['project:edit','project:file','project:change']`，以及 `'project-edit-candidates'` / `'project-edit-validation'`。
- **`src/tool-library/builtin/ContextRetrieval.tool.ts`**
  - L58-61：`/^(?:source|view|read-page):/` 是 Project 的 fileRef 和续读前缀（`project/src/utils/agent/file-refs.ts:87,108,146`），报错文案里还点名了 project:read。
  - L63-70：按 path/revision 召回走 `fileContextFor`。
- **`src/tool-library/builtin/ContextRetrieval.ts:17-18, 55`**：“项目文件历史快照”参数，以及 `refKind 'file-snapshot'`。
- **装配点：**
  - `src/agent/context/ProviderSendRequest.ts:23, 102-126, 156-160`：seedHistory → prepare → 按 15% 窗口预算投影 → finalizeMessages，这个顺序是写死的。
  - `src/agent/context/ProviderSendRequest.ts:115`：调用恢复投影。
  - `src/agent/runner/AgentRunner.ts:446`、`src/agent/LoopRuntime.ts:425`：调用 `forkFileContext`。

**使用方：**
- `Platform/packages/project` 通过 `@velaros-ai/agent/tool-contract` 的 `fileContextFor` / `FileContextSnapshot` 注册来源（`utils/agent/file-context.ts`，以及 `impl/tools/read|search|change|transaction.ts`、`impl/operations/ProjectChangeOperations.ts`）。
- `project/test/source-view.test.ts:10` 和 `project/scripts/model-guidance-audit.ts:9-11` 直接用相对路径 import agent 的内部源码（`../../agent/src/...`）。这本身就说明代码放错了包。
- Desktop 和 Workbench 没有直接 import，但它们都经 `@velaros-ai/project` 在运行时走这条链（Desktop 有 68 个文件、Workbench 有 14 个文件 import 该包）。`Workbench/tests/workspace-capability-provider.test.ts` 直接用了 `fileContextFor`。
- agent 自己的测试有 5 个：fileContext、privateFileRecords、projectReadSerialization、toolOutputStoreSourceWindows、transientRecoveryProjection。

**建议去处：** 整体搬到 `packages/project`。agent 只保留几个中立扩展点：
- 新增 `ToolResultBudgetFitter`（见专题二）。
- 新增 `ProviderRequestTailContributor`：包含 seedHistory、prepare、project(history, budget)、finalize 四步，也就是 `ProviderSendRequest.ts:102-160` 现在的调用顺序。
- 召回域注册：`context:recall` 的 path/revision/file-snapshot 参数和 `source:|view:|read-page:` 引用改由 Project 贡献。
- 私有记录判断改为贡献的谓词。
- 子 Agent 状态 fork 钩子，替代那 7 个工具名的判断。

过渡做法：先把 7 处 project 字面量收进 `FileContextSource` 的扩展字段。

**风险：高。**
- 发送主链的字节会变，影响 B3 重放、前缀缓存指纹和 `test/fixtures/provider-request-basic.json`。
- 预算语义（15%、32K 上限、减半循环）必须原样搬过去。
- `fileContextFor` 和 `FileContext*` 类型在 public-api 基线里，agent 和 project 必须同一班车发版。
- project 的三个集成测试（file-context-integration、batch-read-visibility、source-view）会断言这个头出现在编译结果里。
- `context:recall` 的 schema 模型可见，改动会影响模型行为。

### P0-2　LoopRuntime 写死 system/project 端口（新回归）

- **位置：** `src/agent/LoopRuntime.ts`
  - L88-89：`SubAgentContextBase.system?` / `project?`。
  - L139-157：`CommandRunningPort` 和 `withoutBackgroundCommands`，写死了 `runCommand(command, {background})` 的签名。
  - L367-368：直接包装 `system` 和 `project` 两个具体端口。
- **来源：** `3489fa6` 新增，同时新增了 `test/subAgentBackgroundCommandBoundary.test.ts`。
- **使用方：** Desktop（`Desktop/src/main/tools/ToolContextTypes.ts:127,157`）、Workbench（`WorkbenchAgentExecutionStack.ts:631`）。
- **建议去处：** 由端口自己提供子 Agent 视图（system/project 包里实现 `forSubAgent()`），或者给 `CapabilityDelegationPolicy`（`src/capabilities/CapabilityExtensions.ts:220-223`）加一个 `deriveChildContext`，由 system/project 贡献。
- **风险：低到中。** “子 Agent 不能起后台进程”这条安全语义必须等价保留。

### P0-3　CodingSessionTracker 里的具体名称和 Project 结果形状（判断见专题一）

- **`src/agent/CodingSessionTracker.ts`**
  - L1379-1388：写死 `'system:run'` / `'project:run'`，并读取 `args.command`。
  - L1270-1272：写死 `'office'` 特性和类别。
  - L363-383：`fileChanges` 结果形状。
  - L389-428：`newRevisions`、`snapshot.{path,revision}`、`files[].snapshot`。
  - L430-518：修订提示、外部触碰冷却、`seedResourceTruth`、`getRecentFileChanges`。
- **`src/coding/paths.ts:2-104`**：42 个源码扩展名和 27 个构建/锁文件名（package.json、tsconfig.json、bun.lock、go.mod、pyproject.toml、Dockerfile、vite.config.* 等）。被 `coding/edit-results.ts:28-35`、`coding/AutoVerification.ts:96-110`、`kernel/final-readiness.ts:3-6,33,91`、`agent/RunCompletion.ts:1,11` 使用。
- **`src/coding/edit-results.ts:37-74`**：`changedFiles/path/fromPath/toPath/files[]` 结果形状。
- **`src/agent/runner/host-ports.ts:88-101`**：`RunnerCodingSessionPolicyBundle` 里的 `externalTouchCooldownMs` 和 `nonCodeMutation`。
- **使用方：**
  - `Desktop/src/main/agent/CodingSessionTracker.ts`：子类，注入 Project 的冷却和路径归一，并覆写 `recordVerificationPlanResult('run_verification_plan')`。
  - `Desktop/src/mods/project/main/domain/signals/Coordinator.ts:100`：调用 `notifyExternalFilesystemTouches`。
  - `Desktop/src/main/execution/Runtime.ts:478`。
  - `Workbench/src/main/agent/WorkbenchAgentExecutionStack.ts:590`。
  - `Platform/tests/capabilities/tool-operation-approval.test.ts`，以及 agent 测试 9 个。
- **风险：中。** public-api 基线里有 `CodingSessionTracker`、`isVerificationRelevantPath`、`hasVerificationRelevantModifiedPaths`。

### P0-4　上下文检索写死 Desktop 的日志和产物路径，以及“终端”语义

- **`src/agent/context/retrieval/References.ts`**
  - L83-94：日志前缀 `'vela-command-','vela-bg-','vela-system-command-','vela-system-bg-'`，以及 `'/.velaros/artifacts/'`。
  - L100-112：文本产物扩展名白名单。
  - L157-194、254：只认 `logPath` 这个键。
  - `ReferenceReader.ts:1` 直接用 `node:fs` 读盘。
- **这些名字的生产者都在 Desktop：**
  - `Desktop/src/mods/project/main/storage/commands/Runner.ts:187,319`
  - `Desktop/src/mods/system/main/storage/commands/Runner.ts:105,193`
  - `Desktop/src/main/tools/collections/richOutput/Artifacts.ts:86-96`（`artifact:produce`）
- **终端语义：**
  - `retrieval/ContextRetrievalService.ts:888`（`searchTerminalOutput`）
  - `ContextRetrieval.ts:31-39`（`'terminal'` kind）
  - `ContextRetrieval.tool.ts:151-160`
  - `protocol/types/index.ts:610-646`
- **使用方：** `Desktop/src/main/agent/context/ToolContext.ts`、`Workbench/src/main/agent/WorkbenchContextRecall.ts`、`Platform/packages/system/spec/acceptance.test.ts:364-467`。
- **建议去处：** 改成能力贡献的“引用资源解析器 / 召回域”：system/project 声明自己的日志键和命名，Desktop 声明产物目录，读盘也跟着贡献方走。
- **风险：中。** `context:recall` schema 会变；`IndexSnapshot.ts:45` 已持久化的 `logReferences` 需要兼容读取。

### P0-5　HTML 实时预览 / Widget

- **`src/prompts/catalog.ts:127-173`**：三段内置提示词，写死了 skill id `'widget-visual-output'` / `'html-artifact-output'`（在 `Desktop/resources/skills/`）、`<artifact>/<patch>` 流式协议和 `artifact:produce`。
- **`src/agent/PromptState.ts`**
  - L112-152：`HtmlArtifactVisualSignal` 关键词正则，`'html-artifact'`。
  - L276-285：`'widget'`。
- **`src/agent/SoloModelRequestOptions.ts:10-31`**：`HtmlArtifactMinimumOutputTokens=24_000`，调用点在 `SoloLoop.ts:539`。
- **`src/agent/index.ts:111, 251-252`**：对外导出。
- **`src/protocol/types/index.ts`**
  - L104-127：widget 产物引用和版本（htmlSource/compiledHtml）。
  - L129-177：`HtmlArtifactBlock`、`RenderPatch`、`ProtocolDiagnostic`，与 `Platform/packages/html-artifacts/src/protocol.ts:45-80` 重复定义。
  - L179-187：`ContentBlock` 是封闭联合。
  - L982：`widgetArtifacts`。
- 特性 id 由 `Desktop/src/shared/capabilities/DesktopPromptFeatures.ts:41-121` 定义。
- **使用方：** `Platform/packages/ui`（6 个文件，如 `conversation/contracts/conversation.ts`）、Desktop renderer（`chatSessionWidgetArtifacts.ts` 等 3 个文件）。
- **建议去处：**
  - 提示词：HTML 部分交给 html-artifacts 包，Widget 部分交给 Desktop，各自做成 `CapabilityPromptContributor`。
  - 视觉意图判断：用 `CapabilityIntentClassifier`。前提是给 contributor 的快照补上本轮意图信号，现在 `RuntimePromptSnapshot` 里没有最新用户文本。
  - 24K 输出下限：新增“按特性的请求策略下限”中立扩展点。
  - 协议类型：从 `@velaros-ai/html-artifacts/protocol` 导出，`ContentBlock` 改成开放联合。
- **风险：中。** Tier1 提示词字节会变，public-api 基线要改，UI 里对 `ContentBlock` 的穷尽判别要改。

### P0-6　Office 伞特性

- **位置：**
  - `src/tools/prompt-feature-policy.ts:26,39`：`isOfficeFeature`。
  - `src/tools/registry.ts:131, 143-165`：写死 `'office'` 总开关。
  - `CodingSessionTracker.ts:1270`。
- **使用方：** `Desktop/src/main/agent/PromptFeaturePolicy.ts:31` 实现了它；agent 测试 `promptTierStructure`、`toolPromptFeatureLease`；Workbench 没用。
- **建议去处：** 接口改成中立的 `getCoveringFeatures(feature)` 这类形状，由 Desktop 实现。
- **风险：低。**

### P0-7　Desktop 宿主的 IPC 和落盘 DTO 放在 agent 线协议里

- **`src/protocol/types/index.ts`**
  - L1018-1063：`StoredChatSession`（folderId、sidebarOrder、isMemberPinned 等）。
  - L976-983：`ChatSessionPayloadSnapshot`（注释写着 localStorage）。
  - L1066：`ChatSessionStateSaveSnapshot`。
  - L1088-1152：`ChatFolderRegistry*`（对应 `folders.json`），其中 L1114 和 L1128 写死 `engineId:'claude-code'|'codex'`。
  - L1162：`ChatStartupSessionStateResponse`。
  - L1346-1400：`ChatHook*`（Desktop 的自动化钩子，send_task / bridge_ping 等）。
  - L1402-1412：`BackendLogNotification*`。
  - L1414-1423：`ChatStreamSnapshot*`。
- **`src/chat/resolveStoredChatSession.ts`**。
- **使用方：** 几乎只有 Desktop（例如 `ChatFolderRegistrySnapshot` 14 个文件、`ChatStreamSnapshot` 15 个文件）。Workbench 只在 `Workbench/src/main/agent/context/WorkbenchContextPayloadStore.ts` 用了 `ChatSessionPayloadSnapshot`。
- **建议去处：** Desktop 的 shared 协议或 `@velaros-ai/platform`。engineId 改成 `string`。
- **风险：低到中。** 主要是 import 改路径和 public-api 基线。

### P0-8　`src/agent/retry.ts:27` 的 `'desktop_offline_seat_occupied'`

Cloud 和 Desktop 里都已经没有生产者，属于死知识，直接删除。

---

## 二、应当改注入（P1 中 / P2 低）

### P1-1　厂商协议知识（与 `@velaros-ai/model` 重复）

- **`src/agent/model/PromptCache.ts:21-23, 117-142, 161-183`**
  - 写了 `anthropic.cacheControl` / `openai.promptCacheKey` 的判断。
  - `Platform/packages/model/src/PromptCacheModelOptions.ts` 有同名导出，而且那里才是唯一的翻译层。
  - 建议 agent 只写 `providerOptions.velaros` 这个中立标记。
- **`src/agent/stream/raw-text.ts:14-207`**
  - 解析 Anthropic SSE、OpenAI Responses，以及 chat-completions 的 8 种思考字段拼法。
  - 与 `model/src/ProviderRawStreamText.ts` 近乎逐行重复。
  - 建议在 `ResolvedAgentModelRuntime`（`src/agent/model/ModelContracts.ts:26-39`）上加一个可选的 `rawChunkText` 端口，由 model 包提供。
- **`src/agent/stream/recorder.ts:12-17`**：写死了 providerMetadata 下 anthropic/vertex/bedrock/venice 的缓存 token 路径。
- **DeepSeek 相关：**
  - `src/agent/stream/leaked-tool-markup.ts:1-18, 44-69`：DeepSeek DSML 泄漏标记。
  - `src/agent/stream/Consumer.ts:91`：`RawReasoningStreamId="deepseek-reasoning"`，这个值会写进持久化历史，改名需要兼容读取旧值。
  - 建议由 model 包的 DeepSeek 适配器贡献过滤器。
- **`src/agent/context/tokenizer.ts:1-40`**：o200k 分词器，带来 `gpt-tokenizer` 依赖和一个环境变量开关。建议改成 `TokenCounter` 端口。
- **`src/agent/retry.ts:18-45, 81-105`**：厂商错误码和错误文案列表。model 包已有 `planModelProviderRetry`，建议改成错误分类端口。

### P1-2　产品角色 id

- **位置：** `src/agent/LoopRuntime.ts:163` 默认 `'operator'`；`L458-467` 写死 `'coder'`、`'architect'`、`'chat'`。
- 角色实际定义在 `Desktop/src/main/agent/DesktopAgentRoles.ts`，这与 `protocol/types/system.ts:5` 注释写的“Core 不注册内置角色”相矛盾。
- **建议：** 角色 provider 提供 `expectedOutput` 和默认角色。

### P1-3　运行环境提示段

- **位置：** `src/agent/AppRuntimeFacts.ts`（进程级可变单例）和 `src/prompts/catalog.ts:51-83, 108-116`（包括“生成命令时以 Shell 为准”这句）。
- **使用方：** 只有 `Desktop/src/main/bootstrap/Services.ts:128` 写入。
- **建议：** 改成 system 空间的 promptContributor。

### P1-4　上下文治理里的编码偏置

- **位置：**
  - `src/agent/context/residency/anchors.ts:70-75, 116, 275`：23 种扩展名，bun/npm/pnpm/yarn，pytest/jest/vitest/tsc，cargo/go test。
  - `residency/skeleton.ts:28-46`：骨架栏位写死 files/commands/verification。
  - `retrieval/search/Ranking.ts:7-11`：路径提示扩展名。
- **建议：** 给已有的 `ContextRecordClassifier`（`residency/admission.ts:75-81`，Desktop 已通过 `ContextGovernanceWiring.ts:202` 注入）增加锚点抽取能力，由 project/system 贡献模式。
- **风险：中到高。** 会影响 B3 重放和驻留判决的确定性。

### P1-5　工具入参和结果序列化里的具体字段

- **`src/tools/toolInputHistoryProjection.ts:9, 54`**：写死 `latexSource`（office pdf 工具）、`widget_code`（Desktop Widget）、`html`、`svg`。
- **`src/tools/toolResultSerialization.ts`**
  - L237-250：大字段集合里的 `widget_code`。
  - L216：`systemToolSuggestion`（由 Desktop project Runner 产出）。
  - L502-560：旧 `read_file` / `read_files` 结果形状的修补，现在已没有生产者。
  - L565-592：`SerializationHints`，专门认 bash 的 `maxOutputChars` 和 read 的 `maxChars` / `maxBytes`。
- **建议：** 改成工具契约上的字段元数据；旧 read_file 修补直接删除。

### P1-6　读取具体能力的上下文字段

- **`src/tools/ExecutionPolicyFailures.ts:257-268`**：读 `error.context.projectError`（写入方是 `project/src/utils/tool.ts:80-82`）。建议改成中立键。
- **`src/tools/recovery/ToolInputReuse.ts:89-94, 111-113, 356`**：用 `context.project?.getRootPath()`。建议改用 `resourceId`，或者给 options 加一个 `resolveScope`。
- **`src/tools/recovery/ExecutionProgress.ts:41-47, 69-74`**：写死 baseRevision/actualRevision 等键。优先级 P2。

### P2 项

- **P2-1 内置工具文案点名具体空间：**
  - `BackgroundJobs.tool.ts:32, 85`（`system:list-tasks`）、`L49`（bash / curl）。
  - `AgentWorkflow.tool.ts:25, 47`。
  - `Categories.tool.ts:49`。
  - `ToolSpaceSchemas.ts:85`。
- **P2-2** `src/bridge/ExternalAgentBridgeLoopbackServer.ts:15-17, 94` 写死 `chrome-extension://` origin。唯一使用者是 `Desktop/src/plugins/chatgpt/main/runtime/ExternalAgentBridgeService.ts`。建议 origin 判断由宿主注入，或者把整个 bridge 外移。
- **P2-3** `src/session/permissions.ts:18, 33, 55` 的 `projectRoot`，外部无人使用，改名即可。
- **P2-4 协议里“命令式验证 / 改动路径”的概念：**
  - `protocol/types/chatRuntime.ts:25-31, 225-229`。
  - `protocol/types/subAgentTask.ts:33-40`。
  - `sub-agent/SubAgentResultBuilder.ts:35-52`。
  - 建议随专题一一起中立化。

---

## 三、可接受

- **中立概念碰巧同名：**
  - system prompt / role `'system'`（如 `protocol/message.ts:5`）。
  - “系统设置禁用”这一原因层（`capability-registry.ts:109`、`tool-space-resolver.ts:294`）。
  - `'terminal'` 作为终态（background-jobs、SubAgentSessionStore、chat/stream）。
  - goal / directive 的通用 artifact。
  - 作为“投影”动词的 `project()`（`residency/projection.ts`、`tool-output-store` 的方法名）。
- **协议里的合法中立身份：**
  - agent 自有的工具命名空间和类别（context:、tooling:、plan:、goal:、directive:、job:、interaction:、agent:、skill:），包括 `coding/tool-dedupe.ts:6-11`。
  - `velaros.agent*` id（`kernel-module.ts:67-70`、`BuiltinAgentMod.ts:44`、`protocol/agent-capability.ts:18`）、`'velaros'` providerOptions 命名空间、`sys_note from="velaros"`、session 归档格式。
  - `ExternalAgentBridgeProtocolDescriptor`（门禁要求保留）。
  - mod 协议的 `identityStrategy 'ordinal'|'path'|'origin'`，以及 `.velarmod`。
- **跨厂商的通用约定：**
  - `inline-reasoning-tags.ts` 处理的 `<think>`。
  - `stream/tool-input.ts:216` 只按结构判断。
  - `OutputTruncationRecovery.ts:5`、`IntentSignals.ts:14-19`、`ToolSearchTerms.ts`。
  - `AgentSkillSourceKind 'project'`（`protocol/types/skill.ts:4`，指项目级技能根）。
  - 128K / 192K / 1M 预算常量。
- **注释级提及（门禁目前不扫，建议顺手中性化，不影响运行）：**
  - `SoloFinishingGate.ts:240`、`turnContext.ts:6-8, 68, 100-121`、`admission.ts:63, 523`、`leaked-tool-markup.ts:5`、`ToolIdentity.ts:181`、`ProviderTurnRequestHelper.ts:235`、`tool-output-store.ts:18`。
  - `remote/*` 里提到 Codex / Claude Code 的注释、`SkillFileStore.ts:143, 456`、`QueryLoop.ts:441` 等。

---

## 四、专题一：`src/coding/` 与 CodingSessionTracker

**判断：** “编码会话 / 验证”这一半属于 Project 空间知识（部分属于 System 的命令执行）。tracker 其余约三分之二是中立的“会话工具状态”：类别、租约、驻留、审批、run profile、prompt feature、遥测、自有工具去重。它只是名字叫 Coding。

**理由：**
- **文件类型：** `coding/paths.ts` 的 42 个源码扩展名和 27 个构建/锁文件名，决定了收尾拦截、`done.verification` 和提醒是否生效。
- **命令：** 验证就等于一条命令（`CapabilityValidationFailure.command`、`final-readiness.ts:76`），去重按 `args.command`，而且只认 `system:run` 和 `project:run`。
- **工具名：** 除了上面两个，注释和接口里点名了 `run_verification_plan`、`apply_edit`、`prepare_edit`、`get_session_edit_log`、`summarize_current_dev_environment`，全是 Desktop 的旧 Project 工具。
- **结果形状：** revision / snapshot / fileChanges / changedFiles，外部 fs.watch 触碰，以及内核写回的回声冷却。

**生产中基本空转：**
- Platform、Desktop、Workbench 全仓里，没有人注入 `activityCategories`、`validationInterpreters`、`reminderProducers`。
  - `Desktop/src/main/execution/Runtime.ts:478` 只传了 3 个字段。
  - Workbench 直接 new，什么都没传。
- 后果：
  - editVersion 只会被 Desktop 的 `notifyExternalFilesystemTouches` 推进。
  - 验证指纹永远不会产生，所以 `system:run` / `project:run` 那个分支不可达。
  - 提醒生产者已被删除，`tickLoopReminders` 和 `runAutomaticVerification` 恒为空。
  - 修订提示、seed、`getRecentFileChanges`、`getUsableContextWindowTokens`、`recordVerificationPlanResult` 在三个仓的生产代码里都没有读者。
- **唯一的活路径：** 外部触碰了代码文件 → modifiedPaths → `AgentRunner.ts:370` 构建 `done.verification={status:'not-run'}` → Desktop renderer 在 `chatStreamProgressState.ts:242` 读取。
- 顺带发现：`coding/tool-dedupe.ts:31` 的 `startsWith('tool_')` 是死分支，因为去重集合里全是 `tooling:` 和 `plan:` 开头的工具。

**建议：**
1. 中立部分改名为 `SessionToolState` 并留在 agent，旧名做别名保留到 1.0。
2. 变更-验证账本（`paths.ts`、`edit-results.ts`、`AutoVerification`、final-readiness 的失败拦截、`RunCompletion` 摘要、修订/触碰相关）搬到 `packages/project`。
3. 通过已有注入口贡献：`RunnerCodingSessionPolicyBundle`（`src/agent/runner/host-ports.ts:88-101`）、`CapabilityValidationInterpreter`（它的 fingerprint / evidenceMatches 足以表达 run 命令去重）、`RuntimeReminderProducer`。
4. 收尾拦截需要新增一个中立的 `FinishingGateContributor`，现在没有这个扩展点。
5. 没有读者的 API 先删。

---

## 五、专题二：`src/tools/projectReadSerialization.ts`

**它做什么：** 把 Project 源码窗口（新形状，或者把旧读结果升级成新形状）按整行、用二分法塞进预算，同时生成 `continuation{path, range, baseRevisions}`。

**三条调用链：**
1. **当轮句柄化：** `Executor.finalizeResult` → `materializeResult`（`src/tools/Executor.ts:1249-1290`）→ `KernelToolResultMaterializer.materialize`（`src/kernel/tool-materialization.ts:47`）→ `*KernelToolOutputStore.project` → `fitSourceWindowsWithinProjection`（`src/kernel/tool-output-store.ts:150-166`）。先按 24K 塞，再按 32K 塞，都放不下才退回头尾截取的句柄。
2. **写历史和回放：** `src/agent/history/turn.ts:50-56` → `serializeToolResultForModel`（`src/tools/toolResultSerialization.ts:624-641`）：先 fit，再做旧 read_file 修补；只要含源码窗口且放得下，就跳过通用的 `compactToolResult`。`src/agent/history/sanitize.ts:985-989` 回放超长结果时也走这里。
3. **发送尾部：** `ProviderSendRequest.ts:102-126` → `FileContextProjection.ts:61, 176`（逐片段 fit，把旧窗口改写成回执）→ `FileContextCoordinator.finalizeMessages` → Project 的 `finalizeProjectModelResult`。

**直接引用：** `project/test/source-view.test.ts:10`（相对路径 import）；agent 的 2 个测试。

**搬到 packages/project 需要的中立扩展点：**
- **`ToolResultBudgetFitter`（新增）**
  - 形状：`{ id, priority?, owns(value): boolean, fit(value, maxChars): unknown }`，挂在 `AgentRuntimeCapabilityExtension` 上。
  - 接入点：
    - OutputStore 的 options：`Executor.ts:263-270` 构造 materializer 时手里已经有 capabilityPorts。
    - `serializeToolResultForModel` 增加 fitters 参数。`turn.ts` 里的 `ToolResults` 是模块单例，要改成按上下文取。
    - `sanitize` 的回放路径。
    - 保留“fitter 声明拥有且放得下就跳过通用裁剪”这条规则（`toolResultSerialization.ts:637-640`）。
- **`ProviderRequestTailContributor`（新增）**：承接 FileContext 的投影，fitter 的第三个调用点随它一起进 project。现有的 `tailBlocks` 入参只能放静态内容，缺的是注册口加预算循环。

**现有扩展点够不够：不够，需要新增。**
- `ToolResultMiddleware`（`CapabilityExtensions.ts:55-62`，调用点 `Executor.ts:1009-1048`）：只在物化前跑一次，没有预算入参，不参与回放和发送尾部；它的输出之后仍会被通用裁剪按字符串长度和数组条数截掉。
- `SerializationHints` 只能放大预算。
- `FileContextSource.finalizeModelResult` 只负责在编译后签发 fileRef。
- `ContextRecordClassifier` 只管驻留判决。

**风险：** 同 P0-1（发送字节和 B3 重放、public-api、agent 与 project 同车发版）。另外 `tool-output-store` 的两档预算回退顺序必须保留。

---

## 六、汇总表

| 文件 | 处理方式 | 级别 |
|---|---|---|
| `src/tools/projectReadSerialization.ts` | 搬 project，作为 `ToolResultBudgetFitter` 的实现 | P0 |
| `src/tools/toolResultSerialization.ts` | 删 project 和 read_file 专用分支，改调 fitter；具体字段改成契约元数据 | P0/P1 |
| `src/kernel/tool-output-store.ts` | `fitSourceWindowsWithinProjection` 改调 fitter | P0 |
| `src/agent/context/resources/*`（Coordinator、Projection、SnapshotArchive、PrivateFileRecords、contracts） | 整体搬 project；过渡期先把字面量收进 `FileContextSource` | P0 |
| `src/agent/context/ProviderSendRequest.ts` | 改走 tail contributor 和恢复投影贡献 | P0 |
| `src/tools/recovery/TransientRecoveryProjection.ts` | 搬 project | P0 |
| `src/tool-library/builtin/ContextRetrieval(.tool).ts` | path/revision/fileRef 前缀/terminal 改成可注册的召回域 | P0 |
| `src/agent/context/retrieval/References.ts`、`ReferenceReader.ts`、`ContextRetrievalService.ts`(`searchTerminalOutput`)、`IndexBuilder.ts`、`PayloadReader.ts` | 日志和产物引用识别改成贡献 | P0 |
| `src/agent/LoopRuntime.ts` | L88-89、139-157、367-368 改为端口或委派策略贡献；L163、458-467 角色交给 provider | P0 / P1 |
| `src/agent/CodingSessionTracker.ts`、`src/tool-library/context/CodingSessionTypes.ts`、`src/agent/runner/host-ports.ts:88-101` | 拆开：中立状态留下改名；账本搬 project；删 run/office 字面量 | P0 |
| `src/coding/paths.ts`、`edit-results.ts`、`AutoVerification.ts` | 搬 project（`verification.ts` 可留；`tool-dedupe.ts` 留并修死分支） | P0 |
| `src/kernel/final-readiness.ts`、`src/agent/RunCompletion.ts`、`src/sub-agent/SubAgentResultBuilder.ts` | 改由验证贡献者提供 | P0/P1 |
| `src/prompts/catalog.ts` | L127-173 交给 html-artifacts / Desktop 的 contributor（P0）；L51-116 交给 system 的 contributor（P1） | P0/P1 |
| `src/agent/PromptState.ts`、`src/agent/SoloModelRequestOptions.ts`、`src/agent/index.ts` 导出 | 意图分类器 + 特性请求下限端口 | P0 |
| `src/protocol/types/index.ts` | L104-187、982 移到 html-artifacts/protocol，`ContentBlock` 开放；L976-1163、1346-1423 移到 Desktop | P0 |
| `src/chat/resolveStoredChatSession.ts` | 移到 Desktop | P0 |
| `src/tools/prompt-feature-policy.ts`、`src/tools/registry.ts` | 伞特性接口中立化 | P0 |
| `src/agent/retry.ts` | L27 删除（P0）；错误码表改错误分类端口（P1） | P0/P1 |
| `src/agent/model/PromptCache.ts` | 去掉厂商键 | P1 |
| `src/agent/stream/raw-text.ts`、`recorder.ts`、`Consumer.ts:91`、`leaked-tool-markup.ts` | 改成 model 运行时端口 | P1 |
| `src/agent/context/tokenizer.ts`（及 `gpt-tokenizer` 依赖） | `TokenCounter` 端口 | P1 |
| `src/agent/AppRuntimeFacts.ts` | system 的 contributor | P1 |
| `src/agent/context/residency/anchors.ts`、`skeleton.ts`、`retrieval/search/Ranking.ts` | 扩展 `ContextRecordClassifier` | P1 |
| `src/tools/toolInputHistoryProjection.ts` | 契约字段元数据 | P1 |
| `src/tools/ExecutionPolicyFailures.ts` | 改用中立 context 键 | P1 |
| `src/tools/recovery/ToolInputReuse.ts` | 改用 `resourceId` / `resolveScope` | P1 |
| `src/tools/recovery/ExecutionProgress.ts` | 前置条件键提取器改贡献 | P2 |
| `src/tool-library/builtin/BackgroundJobs.tool.ts`、`AgentWorkflow.tool.ts`、`Categories.tool.ts`、`ToolSpaceSchemas.ts` | 文案中立化 | P2 |
| `src/bridge/ExternalAgentBridgeLoopbackServer.ts` | origin 判断注入，或外移 | P2 |
| `src/session/permissions.ts` | 字段改名 | P2 |
| `src/protocol/types/chatRuntime.ts`、`subAgentTask.ts` | 验证概念中立化 | P2 |
| `inline-reasoning-tags.ts`、`tool-input.ts`、`IntentSignals.ts`、`ToolSearchTerms.ts`、`kernel-module.ts`、`BuiltinAgentMod.ts`、`protocol/mods.ts`、`protocol/types/skill.ts`、`history/internalMessages.ts`、各处注释 | 保留 | 可接受 |

**门禁建议（可选）：** 给 `<仓库所在目录>/VelarOS-Platform/scripts/agent/check-arch-boundaries.mjs` 的防线⑤词表增补 `project|system:|office|html-artifact|widget|desktop|renderer|anthropic|openai|deepseek|claude|codex|chrome-extension|vela-(command|bg|system)`，用当前违规生成基线后按棘轮归零。这样 `3489fa6` 这类新回归就能当场被拦下。