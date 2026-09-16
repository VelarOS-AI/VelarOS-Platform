# `@velaros-ai/model` 0.6.4 → 0.7.0 迁移表

这是一次**破坏性**发布：9 个入口收成 3 个，70 个名字从对外面上消失，10 个名字是新的。
本文件按符号逐条给出去向，并标出每一条在 Platform 仓内与三个产品仓（Desktop、Workbench、
Termel）里的消费点数量。

- 仓内消费点**本轮已全部改完**。
- 产品仓的调用点**本轮不改**，只列进第 6 节，由各产品仓自己按这张表改。
- 判断口径：消费点 = 直接 `import … from '@velaros-ai/model*'` 的源文件数（注释与文档不计）。

改造方案见 `model.md`（§2.5 三个入口、§3.4 要删的导出与替代）；裁决见
`../foundation-pending-decisions.md` 第五节 C1、C8 前半；仓库标准见
`../../architecture/module-ownership.md`。

---

## 1. 入口前后对照

| 旧入口（9） | 新入口（3） | 说明 |
| --- | --- | --- |
| `.` | `.` | 0.6.x 的根入口自称可移植、实际只有主进程在用；0.7.0 起它就是 Node 宿主入口 |
| `./contracts` | `./contracts` | 常量表 + `types/model.ts` 的可移植数据；渲染进程可加载 |
| `./catalog` | `./catalog` | 内容全换：原先是十几个目录函数加 `LocalModelEnvironment` 类，现在是 `./contracts` 的全部 + 一个 `modelCatalog` 实例 |
| `./node` | `.` | 它本来就 `export * from './index'`，两边差的只是几个类 |
| `./profiles` | `.`（`modelProfiles`） | 四个函数变成一个实例的四个方法 |
| `./provider-retry` | `.`（`modelProviderRetry`） | 同上 |
| `./usage` | `.`（`modelUsage`） | 同上 |
| `./provider-scripts/node` | `.` | 零消费；作者契约进注入面 |
| `./ProviderScriptContextWindow` | `.`（`modelCatalog.scriptContextWindow`） | 零消费 |

新入口的值一共 31 个：

| 入口 | 值 |
| --- | --- |
| `.` | `createModelRuntimeComposition`、`createModelRequestClient`、`createModelKernelModule`、`ModelCapability`、`modelCatalog`、`modelProfiles`、`modelProviderRetry`、`modelUsage`，加 `contract/constants.ts` 的 23 张常量表与身份字符串 |
| `./catalog` | `modelCatalog` + 同一批常量表 |
| `./contracts` | 只有常量表 |

`browserSafeEntries` 是 `contracts.ts` 与 `catalog.ts`：两条的引用链不碰 Node 内置模块，
也不去发现宿主进程的环境（`check:model-arch` 逐条核对）。Desktop 的
`scripts/checks/rendererModelBoundary.mjs` 与 `arch-guard-velaros` 的渲染边界规则本来就只
放行这两个入口，**规则不用改**。

---

## 2. 新增的名字（10）

| 新名 | 它顶替了谁 |
| --- | --- |
| `modelCatalog`（`ModelCatalogApi`） | `getModelProviderOperationalManifest`、`getSharedProviderCatalog`、`getSharedProviderModels`、`getSharedProviderSuggestedModels`、`getVisibleProviderModels`、`getResolvedProviderModel`、`resolveProviderModelSelection`、`isOpenRouterCompatibleProvider`、`resolveProviderModelContextWindow`、`resolveProviderScript(Metadata)ContextWindow`、`resolveOllama*` 四个，共 14 个顶层函数 |
| `modelProfiles`（`ModelProfilesApi`） | `resolveModelProfileCredentialSource`、`resolveModelProfileCredential`、`omitModelProfileCredential`、`runModelConnectionProbe` |
| `modelProviderRetry`（`ModelProviderRetryApi`） | `planModelProviderRetry`、`waitForModelRetry` |
| `modelUsage`（`ModelUsageApi`） | `normalizeModelRunUsage`、`normalizePersistedModelUsage`、`summarizeModelUsage`，另新增 `pricingRates(catalog, provider, model)`——单价目录到单价对的查表，产品原先各写一份 |
| `createModelRequestClient` | `new ModelRequestClient(...)` |
| `ModelRuntimeCompositionApi` | 值别名 `ModelRuntimeComposition` 与类 `DefaultModelRuntimeComposition` 的类型位 |

---

## 3. 有替代的旧名（56）

### 3.1 目录与选型：全部改成 `modelCatalog` 的方法

| 旧名 | 新名 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `getModelProviderOperationalManifest(p)` | `modelCatalog.manifest(p)` | `.` / `./catalog` | 3（已改完） | Desktop 1、Workbench 1 |
| `getSharedProviderCatalog(p)` | `modelCatalog.catalog(p)` | `.` / `./catalog` | 3（已改完） | — |
| `getSharedProviderModels(p)` | `modelCatalog.models(p)` | `.` / `./catalog` | 0 | — |
| `getSharedProviderSuggestedModels(p)` | `modelCatalog.suggestedModels(p)` | `.` / `./catalog` | 0 | Desktop 1 |
| `getVisibleProviderModels(p, models)` | `modelCatalog.visibleModels(p, models)` | `.` / `./catalog` | 0 | Desktop 1 |
| `getResolvedProviderModel(p, current?)` | `modelCatalog.resolveModel(p, current?)` | `.` / `./catalog` | 0 | Desktop 1 |
| `resolveProviderModelSelection(p, current?)` | `modelCatalog.resolveModelSelection(p, current?)` | `.` / `./catalog` | 1（已改完） | — |
| `isOpenRouterCompatibleProvider(p)` | `modelCatalog.isOpenRouterCompatible(p)` | `.` / `./catalog` | 0 | Desktop 1 |
| `resolveProviderModelContextWindow(p, m)` | `modelCatalog.contextWindow(p, m)` | `.` / `./catalog` | 0 | — |
| `resolveProviderScriptContextWindow(input)` | `modelCatalog.scriptContextWindow(input)` | `.` / `./catalog` | 0 | — |
| `resolveProviderScriptMetadataContextWindow(m?)` | `modelCatalog.scriptMetadataContextWindow(m?)` | `.` / `./catalog` | 0 | — |
| `resolveOllamaBaseURL(def, env?)` | `modelCatalog.resolveOllamaBaseURL(def, env?)` | `.` / `./catalog` | 0 | Desktop 1 |
| `resolveOllamaChatModel(def?, env?)` | `modelCatalog.resolveOllamaChatModel(def?, env?)` | `.` / `./catalog` | 2（已改完） | Desktop 1 |
| `resolveOllamaContextWindow(def?, env?)` | `modelCatalog.resolveOllamaContextWindow(def?, env?)` | `.` / `./catalog` | 2（已改完） | — |
| `resolveOllamaVisibleChatModels(def?, sel?, env?)` | `modelCatalog.resolveOllamaVisibleChatModels(def?, sel?, env?)` | `.` / `./catalog` | 0 | Desktop 1 |

### 3.2 三个产品共用机制：函数并成实例方法

| 旧名（旧入口） | 新名 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- |
| `./profiles` 的 `resolveModelProfileCredentialSource` | `modelProfiles.credentialSource` | 1（已改完） | Termel 1 |
| `./profiles` 的 `resolveModelProfileCredential` | `modelProfiles.credential` | 1（已改完） | Desktop 1、Termel 1 |
| `./profiles` 的 `omitModelProfileCredential` | `modelProfiles.omitCredential` | 1（已改完） | Termel 1 |
| `./profiles` 的 `runModelConnectionProbe` | `modelProfiles.runConnectionProbe` | 0 | Termel 1 |
| `./provider-retry` 的 `planModelProviderRetry` / `waitForModelRetry` | `modelProviderRetry.plan` / `.wait` | 1（已改完） | Termel 1 |
| `./usage` 的 `normalizeModelRunUsage` / `normalizePersistedModelUsage` / `summarizeModelUsage` | `modelUsage.normalizeRunUsage` / `.normalizePersistedUsage` / `.summarize` | 1（已改完） | Termel 1 |

泛型也跟着收窄了：`omitModelProfileCredential<TProfile>` 与 `runModelConnectionProbe<T>` 的类型参数
声明在 impl 里，公开签名不许引用 impl 的类型参数（门禁硬约束），所以实例方法收的是
`Record<string, unknown>` 与 `unknown`，调用方在自己那边断言。

### 3.3 类 → 工厂 / 接口

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `new ModelRequestClient(o)` | `createModelRequestClient(o)`；类型位用 `ModelRequestClientApi` | `.` | 3（已改完） | Desktop 8、Workbench 2、Termel 1 |
| `ModelRequestService` / `ModelRequestServiceOptions` | 同上（它们本来就是别名） | `.` | 1（已改完） | Desktop 1 |
| `new DefaultModelRuntimeComposition(o)`、值别名 `ModelRuntimeComposition` | `createModelRuntimeComposition(o)`；类型位用 `ModelRuntimeCompositionApi` | `.` | 2（已改完） | Desktop 8、Workbench 5 |
| `ModelProviderCollection`（类型位） | `ModelProviderCollectionApi`；实例从 `composition.providerCollection` 取 | `.` | 2（已改完） | Desktop 5、Workbench 0 |
| `AgentModelResolver`（类型位） | `AgentModelResolverApi` | `.` | 0 | Desktop 7 |
| `AgentModelRuntime`（类型位） | `AgentModelRuntimeApi` | `.` | 0 | — |
| `new ProviderModelCatalogService(o)` | `composition.providerModelCatalogService`（类型位 `ProviderModelCatalogApi`）——**产品不要再自己造一份**，缓存与 OpenRouter 归属都在这一份上 | `.` | 1（已改完） | Desktop 1、Workbench 2 |
| `new ProviderScriptRegistry(o)` | `createModelRuntimeComposition({ providerScripts: o }).providerScriptRegistry`；类型位用 `ProviderScriptRegistryApi` | `.` | 3（已改完） | Desktop 3 |
| `VelarCloudModelRuntime`（类型位） | `VelarCloudModelRuntimeApi`；实例从 `composition.velarCloudRuntime` 取 | `.` | 1（已改完） | Desktop 1 |
| `new LocalModelEnvironment(vars)` / `NodeLocalModelEnvironment` | 不出包；要按显式环境解析 Ollama 就给 `modelCatalog.resolveOllama*` 传 `ModelEnvironmentPort` | — | 2（已改完） | — |
| `ModelAdapterRegistry` / `createModelAdapterRegistry` / `createLegacyModelAdapterRegistry` | `composition.modelAdapterRegistry`（`ModelAdapterRegistryApi`） | `.` | 2（已改完） | — |
| `ModelAdapterRegistryPort` / `ModelRegistryPort` | `ModelAdapterRegistryApi`（同一个概念不再有三个名字） | `.` | 2（已改完） | Desktop 1 |
| `ModelAdapter` 基类与 `AnthropicModelAdapter` / `GoogleModelAdapter` / `DeepSeekModelAdapter` / `OpenAIModelAdapter` / `OpenAICompatibleModelAdapter` / `VelarModelAdapter` / `ProviderScriptModelAdapter` / `UserJsModelAdapter` 八个类 | 扩展点换成注入面接口 `ModelProviderAdapter`（C8 前半）：实现它，从 `createModelRuntimeComposition({ adapters })` 传进来，排在内置适配器之前匹配 | `.` | 1（已改完） | — |
| `AiSdkModelRequestTransport`（类） | 不出包；要换 transport 就实现注入面的 `ModelRequestTransport`，选项形状仍是 `AiSdkModelRequestTransportOptions` | `.` | 1（已改完） | — |

### 3.4 其余函数

| 旧名 | 新名 / 去向 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- |
| `resolveDefaultEmbeddingModelForProvider(collection, p)` | `collection.defaultEmbeddingModel(p)` | 1（已改完） | Desktop 1 |
| `selectEmbeddingModelCandidate` / `filterEmbeddingModelCandidates` | 不出包（utils 的函数不出包）；选 embedding 模型用 `collection.defaultEmbeddingModel` / `collection.isEmbeddingCapable` | 1（已改完） | — |
| `isVelarCloudManagedProviderId(p)` | 不出包；按 `VelarCloudManagedProviderIds` 判 | 1（已改完） | — |
| `applyModelRequestPolicy(request, options?)` | 不出包：请求客户端内部已经兜进去了 | 0 | — |
| `applyPromptCacheProviderOptions` / `applyPromptCacheCallOptions` / `applyThinkingDepthProviderOptions` / `createThinkingDepthProviderOptions` / `mergeOpenRouterReasoning` / `requireThinkingDepth` / `resolveThinkingBudget` / `resolveThinkingDepthEffort` | 不出包：两层出线包装由适配器内部套，思考力度与预算的换算是 wire 细节 | 2（已改完） | — |
| `resolveProviderScriptDevConfigCandidates(cwd?, home?)` | 不出包；注册表自己按 `ProviderScriptRegistryOptions.configPaths` 与缺省候选找 | 0 | — |

---

## 4. 已删、没有替代的名字（14）

| 旧名 | 为什么删 |
| --- | --- |
| `SharedProviderCatalogs` | 21 个 provider 的静态目录整表；要查用 `modelCatalog.catalog(p)` / `.models(p)`，不再把整表拷一份出去 |
| `OpenAiOnlyModels` | 只在 OpenAI 直连下可选的模型名单，是 `visibleModels` 的内部规则数据 |
| `KnownModelContextWindows` | 静态窗口表；查窗口用 `modelCatalog.contextWindow(p, m)` |
| `OllamaEnvNames` | 同一组环境变量名的第三个名字；权威是 `ModelEnvironmentVariables` |
| `velarCloudModelRuntime`（进程级单例，0.6.x 已 `@deprecated`） | 模块级可变单例会让两个宿主的 Cloud 绑定互串；绑定归对象图 |
| `ProviderRawStreamText`、提示词缓存的四个写标记函数、`fetchTavily` | 上一轮包内改造时就已经删掉（零消费，agent 侧自有一份） |

`ModelPricingEntry` / `ModelPricingCatalog` **没有删**：它们现在由公开接口
`ModelUsageApi.pricingRates` 用到，仍从 `./contracts` 出包（Desktop 5 个文件、Workbench 2 个文件
按 IPC 数据用它们）。

---

## 5. 模型面变化

**本轮零变化。** 本包没有模型面工具；内核的唯一可调用操作 `supports_provider` 的名字、入参形状
与说明一个字节没动。`reasoningLevel: 'ultra'` 抬预算（会改发给 Anthropic / OpenAI / Google /
OpenRouter 的请求字节）按裁决**单独一轮**做，不在这次。

`ModelKernelModuleVersion` 保持 `0.3.0`——能力面没变，宿主不需要重新协商。

---

## 6. 产品仓要改的调用点

### 6.1 VelarOS-Desktop（约 60 个文件 + 依赖版本）

绝大多数是**只改 import 路径、名字不变**的类型引用：`@velaros-ai/model/contracts` 的
`ChatProviderId`、`AgentProviderRuntimeConfig`、`ModelSelection`、`ModelPricingCatalog`、
`ReasoningLevel` 等（43 个文件）这一轮**完全不用动**——那个入口的名字一个没少。真正要改的是下面这些：

| 改什么 | 文件 | 怎么改 |
| --- | --- | --- |
| `@velaros-ai/model/node` → `@velaros-ai/model` | `src/main/bootstrap/Bootstrap.ts`、`Composition.ts`、`ProcessEnvironment.ts`、`src/main/agent/DesktopAgentRuntimePolicy.ts`、`src/main/execution/Runtime.ts`、`src/sidecar-host/SidecarComposition.ts`、`SidecarChatExecution.ts`，以及 4 个 maintained 测试 | 入口换掉；`ModelRuntimeComposition`（类型位）→ `ModelRuntimeCompositionApi`；`ProviderScriptRegistry`（类型位）→ `ProviderScriptRegistryApi` |
| `@velaros-ai/model/profiles` → `@velaros-ai/model` | `src/main/config/Normalizer.ts` | `resolveModelProfileCredential(...)` → `modelProfiles.credential(...)` |
| `new ModelRequestClient(...)` → `createModelRequestClient(...)` | `src/main/chat/PureChatExecutionService.ts`、`ChatAuxiliaryModelTasks.ts`、`src/main/agent/SubAgentGuidanceRelayService.ts`、`src/main/agent/context/ContextDistillerWiring.ts`、`src/mods/scheduled-tasks/main/runtime/{ScheduledTaskLedgerSummarizer,ScheduleRuleGenerator}.ts`，以及 1 个 maintained 测试 | 类型位一并换 `ModelRequestClientApi` |
| `new ProviderModelCatalogService(...)` → 从组合对象取 | `src/main/model/Service.ts` | 用 `composition.providerModelCatalogService`；设置页刷新目录与运行时因此共享同一份缓存与 OpenRouter 归属（修方案里的 M5） |
| `AgentModelResolver` / `ModelProviderCollection` / `VelarCloudModelRuntime` 当类型用 | `src/main/{desktop/DesktopSpaceService,agent/context/ContextDistillerWiring,model/AuxiliaryModelRuntime,config/{Store,Service},bootstrap/{RuntimeTypes,composition/{account,config}},knowledge/Runtime}.ts`、`src/mods/project/main/project/{ProjectGitService,ProjectGitMessage}.ts` 等 | 一律加 `Api` 后缀 |
| `ModelAdapterRegistryPort` | `src/plugins/lancedb/main/MemoryVectorBackend.ts` | → `ModelAdapterRegistryApi` |
| `resolveDefaultEmbeddingModelForProvider(collection, p)` | `src/main/knowledge/Runtime.ts` | → `collection.defaultEmbeddingModel(p)` |
| `@velaros-ai/model/catalog` 的目录函数 | `src/shared/model/DesktopModelCatalog.ts`、`src/renderer/src/utils/model/modelOptions.utils.ts`、`src/renderer/src/hooks/chat/config/useChatConfigState.ts` | 全部改成 `modelCatalog.*`（见 §3.1 对照） |
| 渲染边界检查 | `scripts/checks/rendererModelBoundary.mjs`、`tests/maintained/scripts/checks/rendererModelBoundary.test.mjs` | 规则不用改（只放行 `/catalog` 与 `/contracts`）；测试里那条 `import { ProviderScriptRegistry } from '@velaros-ai/model/node'` 的样本要换成别的 Node-only 入口写法 |
| `package.json` / `bun.lock` | — | `^0.7.0` |

### 6.2 VelarOS-Workbench（约 15 个文件 + 依赖版本）

| 改什么 | 文件 |
| --- | --- |
| `@velaros-ai/model/node` → `@velaros-ai/model` | `src/main/index.ts`、`src/main/agent/WorkbenchAgentExecutionStack.ts`、`WorkbenchSubAgentPolicy.ts`、`src/main/workspace/language/WorkbenchInlineCompletion.ts`、`scripts/test/projectSurfaceNaturalAcceptance.ts`，以及 7 个 tests |
| `new ModelRequestClient(...)` → `createModelRequestClient(...)`；类型位 `ModelRequestClientApi` | `src/main/workspace/language/WorkbenchInlineCompletion.ts`、`tests/workbench-inline-completion.test.ts` |
| `ProviderModelCatalogService` 自己造一份 → 从组合对象取 | `src/main/index.ts`、`src/main/model/WorkbenchModelIpc.ts` |
| `@velaros-ai/model/catalog` 的目录函数 → `modelCatalog.*` | `src/renderer/src/runtime/standaloneWorkbenchModelCatalog.ts` |
| `ModelRuntimeComposition`（类型位）→ `ModelRuntimeCompositionApi` | `src/main/agent/WorkbenchSubAgentPolicy.ts`、`tests/workbench-sub-agent-model-routing.test.ts` |
| `package.json` / `bun.lock` | `^0.7.0` |

`@velaros-ai/model/contracts` 的类型引用（10 个文件）不用动。

### 6.3 VelarOS-Termel（4 个文件 + 依赖版本）

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `packages/termel-runtime/src/providers.ts` | `/profiles`、`/node`、`/contracts` 三处 | `/contracts` 不变；另两处并成 `@velaros-ai/model`，四个 profile 函数改 `modelProfiles.*` |
| `packages/termel-runtime/src/provider-retry.ts` | `/provider-retry` | `@velaros-ai/model` 的 `modelProviderRetry.plan` / `.wait`；`ModelProviderRetryOptions` / `Decision` 仍在 `/contracts` |
| `packages/termel-runtime/src/usage.ts` | `/usage` | `@velaros-ai/model` 的 `modelUsage.*`；`ModelRunUsage` 等仍在 `/contracts` |
| `packages/termel-runtime/src/agent-service.ts` | `ModelRequestClient` | `createModelRequestClient`；类型位 `ModelRequestClientApi` |
| `packages/termel-runtime/package.json` / `bun.lock` | 依赖版本 | `0.7.0` |

### 6.4 Platform 仓内（本轮已改完）

| 文件 | 改了什么 |
| --- | --- |
| `packages/model/test/**`（12 个文件） | 入口改根入口；类改工厂与实例方法；`package-entry.test.mjs` 重写成「三个入口 + 16 个已删名字一个都不许再出现」 |
| `tests/model/consumer/package-api.ts` | 整份重写：自定义适配器改实现注入面的 `ModelProviderAdapter`，不再继承 `ModelAdapter` |
| `scripts/model/check-package-consumer.mjs` | 发布文件清单去掉 `dist/node.*` 与 `dist/provider-scripts/node.*`；运行期断言按新三入口重写 |
| `scripts/model/check-arch-boundaries.mjs` | 去掉 `./node` 那一段；根入口改成「不出任何类」的名单核对；`./catalog` 的所有者收成两条 |
| `scripts/release/fixtures/host-contract-consumer/{consumer,model-structured-output}.ts` | `ModelRequestClient` → `createModelRequestClient` / `ModelRequestClientApi` |
| `scripts/ownership/governed-modules.mjs` | model 摘掉 `status: 'migrating'`（燃尽归零） |
| `docs/generated/package-catalog.json`、`bun.lock` | model 版本与入口清单 |

---

## 7. 本轮**没有**做完的（已知偏离方案）

| # | 事项 | 为什么留到下一轮 |
| --- | --- | --- |
| 1 | C8 后半：`reasoningLevel: 'ultra'` 抬预算 | 会改发给四家服务商的请求字节，按裁决单独一轮，与重放基线一起动 |
| 2 | 方案 M1：`reasoningLevel: 'off'` 对 Anthropic / OpenAI / Google / OpenRouter 仍不生效 | 同上，改请求字节 |
| 3 | 方案 M3：Velar embedding 仍绕过宿主注入的带账户认证 fetch | 行为变化，不在本轮拍板清单里 |
| 4 | 方案 M4：`ProviderModelCatalogService.normalizeModels` 每个模型都重建一次全部 21 个预设 | 性能问题，单独一轮 |
| 5 | 方案 D6：20 处用户可见英文（自定义 adapter 报错、`fallbackReason`、Termel 的重试与探测提示） | 文案层，与工具面提示词那一轮一起 |
| 6 | 与 agent 的三件线协议（提示词缓存三个键、`reasoningLevel → thinkingDepth` 映射、请求策略字段名）还没有仓库级一致性测试 | 方案 D8 建议加 `tests/model/prompt-cache-wire.test.ts`，本轮没加 |
| 7 | `docs/generated/package-catalog.json` 的 model 条目是**手改**的，不是 `generate:package-catalog` 生成的 | 生成器在跑的时候会先核对全仓 manifest 与 `bun.lock` 一致，而 browser 包这一轮由另一路在改、两者暂时不一致，生成器跑不起来。手改的内容与生成器的输出逐字段一致；browser 那一路收工后重跑一次 `bun run check:package-catalog` 即可确认 |
