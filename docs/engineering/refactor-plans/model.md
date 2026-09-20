# packages/model 按仓库标准改造方案

> 对象：`~/Desktop/VelarOS/projects/VelarOS-Platform/packages/model`（`@velaros-ai/model` 0.6.4，model 域唯一的包）。分析基于 HEAD `7c39d5c9`，`packages/model` 工作区干净。
> 标准：`docs/architecture/module-ownership.md`、ADR 0003 / 0007 / 0008、样板 `packages/system`、`packages/project`、`packages/platform`，门禁 `scripts/ownership/check-module-ownership.mjs`。
> 方法：只读。消费方扫描覆盖 Platform 的 `packages/ tests/ scripts/ products/`（含 `scripts/release/fixtures`），姊妹仓 Desktop、Workbench、Termel、Extension、Cloud；导出清单由 TypeScript 检查器逐个名字解析到声明文件（脚本在 `plan-mid/scripts/`，结果在 `plan-mid/exports.json`、`consumers.json`）。缺陷都用 `plan-mid/probes/model-probes.ts` 只 import 源码实测过。
> 基线：`packages/model` 下 `bun test test` 67 pass / 0 fail（12 个文件）。

## 0. 结论先行

1. **规模**：`src/` 45 个 `.ts`（外加 `velaros-globals.d.ts`），7,959 行；27 个类，只有 8 个 `implements` 接口；9 个对外入口共导出 474 个名字（按名字去重 198 个），**被用到的只有 76 个**，其中产品（Desktop、Workbench、Termel）用 61 个、仓内 consumer 测试与发布 fixtures 另用 15 个；`./provider-scripts/node`、`./ProviderScriptContextWindow` 两个入口零消费，`./node` 的 194 个名字只用了 6 个。
2. **主要问题**：① 对外面没有接口控制：27 个类里 22 个直接出包（`ModelRequestClient`、`ModelProviderCollection`、`ProviderModelCatalogService`、`VelarCloudModelRuntime`、`ModelAdapter` 基类……），产品各自 `new` 一份（`new ModelRequestClient()` 11 处、`new ProviderModelCatalogService` 2 处）；② 死代码与重复：`KnownTeamModelCapabilityOverrides`（353 行）、`ProviderRawStreamText`（agent 有自己的一份）、提示词缓存「写标记」四个函数（agent 有自己的一份）、`ProviderRuntimeAvailability` 四个转发函数、四个 Profile 端口、`fetchTavily`（厂商搜索代理，零调用）；③ 三个真缺陷（第 5 节，全部实测复现）：`reasoningLevel: 'off'` 对非 Velar 服务商不生效、内存注册的 provider script 在 `configureHost` 后丢失、Velar embedding 绕过宿主注入的带账户认证 fetch；④ 错误全是 `VALIDATION`，Desktop 渲染层靠匹配「API Key 未配置」文字分支；⑤ 用户看得到的英文 20 处。
3. **目标**：`src/` 收成 `contract/ types/ impl/ utils/ exports/`；impl 28 个类文件分 4 个子目录、3 层；utils 19 个文件（`catalog/`、`wire/`、`scripts/` 三个子目录）；types 5 个文件，`types/model.ts` 是可移植文件；**入口从 9 个收成 3 个**：`.`（Node 宿主）、`./contracts`（可移植数据）、`./catalog`（渲染进程要的目录逻辑，browser-safe）。
4. **要拍板的**（第 7 节）：入口收口与破坏性升级；类不出包、改工厂；`reasoningLevel` 语义修正（会改发请求的字节）；新增 `ModelErrorCodes`；删 `fetchTavily`（改 provider script 作者契约）；`ModelAdapter` 基类换成注入点 `ModelProviderAdapter`；与 agent 重复的提示词缓存标记协议怎么守。
5. **步骤一句话**：先修三个缺陷（各带回归测试）→ 整文件搬家（入口名不变）→ 拆混合文件、类加接口、常量与 tuning、英文改中文、删死代码 → 合同三文件与入口收口（同提交改仓内消费方与迁移表）→ 登记治理、改写 `check:model-arch`。

## 1. 现状

### 1.1 目录与职责

全部平铺在 `src/` 下，按功能命名，没有分层。

| 功能块 | 文件（行数） | 职责 |
| --- | --- | --- |
| 装配 | `ModelRuntimeComposition.ts`(108)、`ModelAdapterRegistry.ts`(115)、`node.ts`(31)、`provider-scripts/node.ts`(23) | 一个宿主一份的对象图：script 注册表、环境快照、provider 集合、Velar Cloud 绑定、适配器注册表、解析器、Agent 运行时、目录服务 |
| 解析 | `AgentModelResolver.ts`(413)、`AgentModelRuntime.ts`(219) | 把宿主的 `ModelSelection` 解析成 Agent 能用的 `LanguageModelFactory`，只在同 provider 内回退模型；把 `unknown` 入参收窄成契约 |
| provider 集合与目录 | `ModelProviderCollection.ts`(269)、`ProviderManifest.ts`(275)、`ModelCatalog.ts`(1,062)、`ProviderModelCatalogService.ts`(521)、`ProviderModelCatalogCache.ts`(100)、`ProviderScriptContextWindow.ts`(73)、`EmbeddingModelSelection.ts`(129)、`ProviderRuntimeAvailability.ts`(59) | 21 个内置 provider 的清单与静态模型目录、上下文窗口查表、远端 `/models` 发现与缓存、embedding 模型选择 |
| 适配器 | `ModelAdapter.ts`(104)、`OpenAIModelAdapter.ts`(268)、`OpenAICompatibleModelAdapter.ts`(135)、`AnthropicModelAdapter.ts`(36)、`GoogleModelAdapter.ts`(36)、`DeepSeekModelAdapter.ts`(28)、`VelarModelAdapter.ts`(116)、`UserJsModelAdapter.ts`(645) | 各厂商 SDK 的 LanguageModel 工厂与 embedding 请求；用户上传 JS 的 VM 沙箱适配器 |
| provider script | `ProviderScriptRegistry.ts`(814)、`ProviderScriptRegistryPort.ts`(65) | 从 `.velaros/dev.json` 或内存登记受信脚本，宿主同权执行 |
| 请求横切 | `PromptCacheModelOptions.ts`(395)、`ThinkingDepthModelOptions.ts`(320)、`ModelRequestPolicy.ts`(37)、`ProviderRawStreamText.ts`(212) | 缓存断点翻译、推理力度映射、请求策略、原始流解析 |
| 通用请求客户端 | `ModelRequestClient.ts`(121)、`ModelRequestTypes.ts`(122)、`AiSdkModelRequestTransport.ts`(62)、`ModelRequestService.ts`(8) | text / object / stream 客户端与可替换 transport |
| 产品共用机制 | `ModelProfiles.ts`(78)、`ModelProviderRetry.ts`(201)、`ModelUsage.ts`(104)、`ModelPricing.ts`(21) | profile 凭据来源、瞬时错误重试计划、usage 归一（只有 Termel 在用） |
| 环境 | `LocalModelEnvironment.ts`(140)、`NodeLocalModelEnvironment.ts`(21) | 不可变环境快照；Ollama 地址/模型/窗口 |
| Velar Cloud | `VelarCloudModelRuntime.ts`(87) | `velaros`、`velar-dev` 两个托管服务的连接绑定 |
| 内核 | `kernel-module.ts`(125) | 把适配器注册表登记成内核能力 `velaros.model`，唯一的 wire 操作 `supports_provider` |
| 契约与入口 | `ModelContracts.ts`(169)、`index.ts`、`contracts.ts`、`catalog.ts` | 公开数据类型；三个聚合入口 |

### 1.2 对外入口：导出了什么、谁在用

| 入口 | 导出（值） | 被用 | 消费方 | 判定 |
| --- | ---: | ---: | --- | --- |
| `.` | 176（85） | 40 | Desktop 44 个文件（主进程）、Workbench 7、Termel 1，仓内 `tests/model/consumer/package-api.ts` 与 `scripts/release/fixtures/host-contract-consumer/` 两个文件 | 自称 browser-safe，实际只有主进程在用；77% 没人用 |
| `./catalog` | 42（33） | 14 | Desktop 渲染/共享层 3、Workbench 渲染层 1、consumer 测试 1 | 渲染进程的目录逻辑，必须保留一个 browser-safe 入口 |
| `./contracts` | 29（0） | 16 | Desktop 43 个文件（`packages/ipc` 与渲染层为主）、Workbench 10、Termel 1 | 纯类型 |
| `./node` | 194（96） | 6 | Desktop 11、Workbench 13（多为测试）、Termel 1 | 只用了 `createModelRuntimeComposition`、`ModelRuntimeComposition`、`ProviderScriptRegistry`、`DefaultModelRuntimeComposition`、`createModelAdapterRegistry`、`ProviderScriptRegistryOptions` |
| `./profiles` | 9（4） | 4 | Termel `termel-runtime/src/providers.ts`、Desktop `main/config/Normalizer.ts`（只用 `resolveModelProfileCredential`） | |
| `./provider-retry` | 4（2） | 4 | Termel | |
| `./usage` | 6（3） | 5 | Termel | |
| `./provider-scripts/node` | 12（3） | 0 | — | 零消费 |
| `./ProviderScriptContextWindow` | 2（2） | 0 | — | 零消费 |

**真正被用的符号清单**（去重，按用途）：

- 装配：`createModelRuntimeComposition`、`ModelRuntimeComposition`（类型，12 个文件）、`DefaultModelRuntimeComposition`、`ProviderScriptRegistry`（Desktop 测试里 `new`）、`ProviderScriptRegistryOptions`、`createModelAdapterRegistry`（只有 consumer 测试）。
- 运行时对象的类型：`AgentModelResolver`（Desktop 12 个文件当类型用）、`ModelProviderCollection`（11，类型为主）、`ModelAdapterRegistryPort`（4）、`ProviderScriptRegistryPort`（4）、`VelarCloudModelRuntime`（1）。组合对象上实际调用的方法：`providerCollection` 的 `resolveModel / requireOperationalManifest / getDefaultRuntimeConfig / resolveBaseURL / isRuntimeConfigured / findRuntimeConfig / resolveModelSelection / requireApiKey / normalizeRuntimeConfigs / listPresets / getApiKeyEnvironmentName`；`providerScriptRegistry` 的 `configureHost / validateProviderRuntime / supportsProvider`；`velarCloudRuntime` 的 `registerProvider / unregisterProvider`；`modelAdapterRegistry` 的 `supportsProvider / createEmbeddingRequest`；`agentModelRuntime` 的 `resolveRoleRuntime / createAgentProvider`；`agentModelResolver.resolve`；`providerModelCatalogService` 的 `listProviderModels / setAttribution`。
- 请求客户端：`ModelRequestClient`（Desktop 8、Workbench 2、Termel 1 处 `new`）、`ModelRequestService`（弃用别名，Desktop 1）、`ModelRequestLanguageModel`、`ModelRequestObjectInput`、`ModelRequestOptions`、`ModelRequestStreamText`、`ModelRequestPolicy`、`ModelRequestTransport`、`ModelRequestClientOptions`。
- 目录服务：`ProviderModelCatalogService`（Desktop `main/model/Service.ts:66`、Workbench `main/index.ts:344` 各 `new` 一份，和组合对象里那份不共享缓存与归属）。
- 目录与清单（渲染进程）：`DefaultProviderModels`、`ModelProviderOperationalManifests`、`getModelProviderOperationalManifest`、`getResolvedProviderModel`、`getSharedProviderSuggestedModels`、`getVisibleProviderModels`、`isOpenRouterCompatibleProvider`、`CustomModelProviderIds`、`OpenRouterFreeModelId`、`OllamaProviderId`、`resolveOllamaChatModel`、`resolveOllamaVisibleChatModels`、`resolveOllamaBaseURL`（主进程）、`LocalModelEnvironment`（consumer 测试）、`resolveDefaultEmbeddingModelForProvider`（Desktop `main/knowledge/Runtime.ts`）。
- 内核：`createModelKernelModule`、`ModelCapability`（Desktop `bootstrap/Composition.ts`、`scripts/checks/kernelAssembly.mjs`）。
- Termel（Desktop 也用 `resolveModelProfileCredential`）：`resolveModelProfileCredential(Source)`、`omitModelProfileCredential`、`runModelConnectionProbe`、`planModelProviderRetry`、`waitForModelRetry`、`normalizeModelRunUsage`、`normalizePersistedModelUsage`、`summarizeModelUsage` 与对应类型。
- 数据类型：`ChatProviderId`（60 余个文件）、`AgentProviderRuntimeConfig`（22）、`ModelSelection`、`ListProviderModelsRequest`、`ValidateProviderRuntimeRequest`、`ProviderModelCatalog(Entry)`、`ProviderScriptManifest`、`OpenRouterRoutingConfig`、`ThinkingDepth`、`ReasoningLevel`、`ModelRuntimeContext`、`ModelPricingCatalog/Entry`、`ModelProviderPreset`、`ModelProviderValidationKind`、`ModelProviderAdapterKind`。

**对外无人用、包内也没人用的 13 个**：`KnownTeamModelCapabilityOverrides`、`isDirectOpenAICompatibleProvider`、`resolveOpenRouterCompatibleModelContextWindow`、`resolveModelContextWindow`、`getModelProviderIdsByAdapterKind`、`isModelProviderEmbeddingCapable`、`resolveAutoEmbeddingSelection`、`findProviderRuntimeConfig`、`getFirstConfiguredProviderRuntimeConfig`、`ModelProfileStorePort`、`ModelCredentialStorePort`、`ModelProfileEnvironmentPort`、`ModelConnectionProbePort`（前 9 个只有本包测试在用）。另有 109 个只在包内用、不该出包。

**绕过入口的引用**：Desktop `scripts/checks/rendererModelBoundary.mjs` 与 `packages/arch-guard-velaros/.../rendererPortablePackageBoundary.ts` 规定渲染层只许 `@velaros-ai/model/catalog` 与 `/contracts`、禁止根入口——目标布局保留这两个名字，Desktop 的这两道检查不用改。`packages/agent/test/model-boundary.test.ts` 断言 agent 不依赖 model。

### 1.3 与别的包的耦合

- 依赖：`@velaros-ai/core`（根、`/error`、`/logger`、`/utils/TimerScope`）、`@velaros-ai/kernel/contracts/abi`（只在 `kernel-module.ts`）、`ai`、`@ai-sdk/{openai,anthropic,google,provider}`；Node 内置模块只在 `ProviderScriptRegistry.ts`（fs、module、os、path、vm）与 `UserJsModelAdapter.ts`（vm），`process.env` 只在 `NodeLocalModelEnvironment.ts` 与 `ProviderScriptRegistry.ts`（`process.cwd()`）；装配文件经它们变成 Node 专属。`package.json` 的 `@types/json-schema` 运行时依赖代码里一处没用。
- 被依赖：Platform 里没有别的包依赖 model（agent 按边界测试刻意不依赖，经宿主注入不透明运行时）。
- **与 agent 的四处镜像**（agent 不许依赖 model，于是各写一份）：提示词缓存标记协议（`velaros.promptCacheBreakpoint` / `promptCacheKey` 三个键，agent 写、model 翻译；agent `utils/model/prompt-cache.ts` 207 行与本包的写标记函数逐字同源）；原始流文本解析（agent `stream/raw-text` 与本包 `ProviderRawStreamText`，已有 7 处细节分叉，本包那份零消费）；`applyModelRequestPolicy`（agent `impl/loop/AiSdkAgentModelRequestPort`）；`reasoningLevel → thinkingDepth` 映射（agent `protocol/constants/typedFieldAsserts.ts:54` 与本包 `ThinkingDepthModelOptions.ts:43`）。
- 门禁：`check:model-arch`（`scripts/model/check-arch-boundaries.mjs`）按路径钉了 `src/index.ts`、`src/contracts.ts`、`src/catalog.ts`、`src/node.ts`、`src/ModelRuntimeComposition.ts`、`src/AgentModelRuntime.ts`、`EmbeddingModelSelection`、`ProviderRuntimeAvailability`、`LocalModelEnvironment/ModelCatalog/ProviderManifest` 与四个 Node 源文件；搬家时要同提交改。`check:host-contract-consumer` 打包 model 并用 `ModelRequestClient` 类型做 NodeNext 编译（`scripts/release/fixtures/host-contract-consumer/consumer.ts`、`model-structured-output.ts`）。

### 1.4 写死了别的空间 / 宿主 / 厂商知识的地方

厂商目录与 SDK 适配是本包本职，不算。下面这些不是：

| 位置 | 内容 | 问题 |
| --- | --- | --- |
| `ProviderScriptRegistryPort.ts:50`、`ProviderScriptRegistry.ts:153,405-420,738` | `fetchTavily('/api/tavily/search'…)` | 网页搜索厂商的代理进了模型端口；全仓与三个产品零调用 |
| `ModelAdapter.ts:72`、`ProviderManifest.ts:116,127,138` | 「记忆会回退为文本检索」「记忆和知识库向量不可用时会回退文本检索」 | 记忆包的行为写进模型错误与清单 |
| `ProviderScriptRegistry.ts:184,319` | 缺省配置 `.velaros/dev.json`；报错「需要先在 .velaros/dev.json 注入 provider script」 | 开发者本机约定进了用户可见报错 |
| `ProviderScriptRegistry.ts:606` | host bridge 缺席时 userData 回落 `~/.velaros`、版本回落 `0.0.0` | 宿主目录约定；应由宿主给 |
| `VelarModelAdapter.ts:59,101` | `apiKey: 'velar-managed'`、`Authorization: 'Bearer velar-managed'` | Cloud 占位凭据；embedding 那条直接出线（见缺陷 M3） |
| `ModelCatalog.ts:453-805` | `KnownTeamModelCapabilityOverrides`（团队路由的模型能力画像） | agent 团队路由的数据，零消费 |
| `ModelProviderCollection.ts:180` 与 `ModelAdapter.ts:91` | 同一个条件两句话：「请在产品模型设置中补充」「请由宿主提供凭证」 | 产品界面措辞进了库；两处不一致，Desktop 还按前半句文字匹配 |

### 1.5 模块级可变状态

| 位置 | 状态 | 处理 |
| --- | --- | --- |
| `VelarCloudModelRuntime.ts:86` `velarCloudModelRuntime` | 进程级单例，可 `registerProvider` 改写 | `@deprecated` 兼容 0.4.x，只被同样弃用的 `createLegacyModelAdapterRegistry` 用；删 |
| `ModelAdapterRegistry.ts:76` 参数缺省 `new NodeLocalModelEnvironment()` | 每次调用读 `process.env` | 组合对象里显式传快照；删缺省 |
| `ModelCatalog.ts:807` `KnownModelContextWindows` | 类型标 `ReadonlyMap`，实物是可写的 `Map` 出包 | 不出包，进 utils 常量 |
| `LocalModelEnvironment.ts:91`、`ModelCatalog.ts:390`、`ProviderManifest.ts:258`、`ProviderScriptRegistry.ts:170`、`UserJsModelAdapter.ts:98-196` | 不可变的查表 Map/Set、`createRequire`、VM `Script` 对象 | 不可变，但 impl 模块级只许放日志和导出实例：查表进 utils，VM 脚本改 `private static readonly` |

### 1.6 一个文件多个类、类不实现接口

- 多类文件：`LocalModelEnvironment.ts`（`LocalModelEnvironment` + `DelegatingModelEnvironment`）、`ProviderScriptRegistry.ts`（注册表 + `ProviderScriptModelAdapter`）、`ModelCatalog.ts`（`ReadonlySetSnapshot` + 1,000 行数据与函数）、`PromptCacheModelOptions.ts` / `ThinkingDepthModelOptions.ts`（各一个 `LanguageModelV3` 包装类 + 一堆函数）。
- 类不实现接口（19 个）：`AgentModelResolver`、`AgentModelRuntime`、`ModelAdapter` 与 7 个子类、`ModelProviderCollection`、`ModelRequestClient`、`NodeLocalModelEnvironment`、`ProviderModelCatalogCache`、`ProviderModelCatalogService`、`ProviderRawStreamText`、`UserJsModelAdapter`、`VelarCloudModelRuntime`、`VelarModelAdapter`、`ProviderScriptModelAdapter`。实现了的 8 个里，`PromptCacheLanguageModel`、`ThinkingDepthLanguageModel`、`ReadonlySetSnapshot` 实现的是上游接口，门禁要求类上方另写一个本包接口（可以 `extends` 上游）。
- 不用实例状态的私有方法（要进 utils）：`OpenAIModelAdapter` 的 `normalizeAllowedModels / mergeOpenRouterAutoRouterPlugin / mergeOpenRouterProviderPreferences / matchesReasoningModel`，`OpenAICompatibleModelAdapter.stripBlankAuthorization / isChatCompletionsRequest`，`AgentModelResolver` 的 `buildResolutionTrace / createUnavailableProviderError / mergeFallbackReason / mergeModelRequestOptions / mergeModelRequestOptionLayers / resolveRuntimeModel(部分)`，`ProviderModelCatalogService` 的 `appendPath / optionalBearerHeader / optionalHeader / readRemoteModelEntries / canListRemoteProviderModels / createEmptyRemoteCatalog`，`UserJsModelAdapter` 的 `buildEvaluationCacheKey / normalizeEmbeddingRequest`，`ProviderRawStreamText` 全部。

### 1.7 用户或模型看得到的英文（20 处，扫描脚本 `plan-mid/scripts/scan-english.cjs`）

| 位置 | 原文 | 谁看得到 |
| --- | --- | --- |
| `AgentModelResolver.ts:397` | `${label} provider script metadata unavailable: …` | 写进 `fallbackReason` 与 resolutionTrace，界面显示 |
| `ProviderScriptRegistry.ts:396` | `Provider script runtime metadata timed out after …ms.` | 同上（被上一条包进去） |
| `UserJsModelAdapter.ts:251,265,499,599,627,633` | `Custom adapter must export createLanguageModelFactory(...)`、`… must return a function.`、`… must return a JSON-safe { url, headers, body } request.`、`… must return helpers.createOpenAI(...)…`、`… must be an object with string values.`、`… contains a non-string value for …` | 设置页上传自定义 adapter 的用户 |
| `kernel-module.ts:33,44,49,53,56,69,105` | `Model capability input is invalid: …`、`expected an object payload`、`"provider" must be a non-blank string`、`Model kernel module requires an injected registry`、`reason: 'Check whether a model provider adapter is registered.'` | 内核调用方、审批与发现界面（reason） |
| `ModelProfiles.ts:68` | `Connection check timed out.` | Termel 的连接探测结果 |
| `ModelProviderRetry.ts:178-180,199` | `Provider rate limit reached` 等三句兜底、`The operation was aborted` | Termel 重试提示 |

### 1.8 测试怎么组织

12 个文件都在 `test/`，一半 `import '../src'` 聚合入口、一半直指源文件（`../src/LocalModelEnvironment`、`../src/VelarModelAdapter.ts`、`../src/ModelRequestService`）；`package-entry.test.mjs` 经包名走 `dist`，并断言根入口**不**导出 `ModelRuntimeComposition`、`ProviderScriptRegistry`。没有 `spec/`、没有不变量登记。另有两处仓库级消费方钉住公开面：`tests/model/consumer/package-api.ts`（只编译不跑，`scripts/model/check-package-consumer.mjs` 用，不在 `check` 链上）与 `scripts/release/fixtures/host-contract-consumer/`（在 `check:gates` 链上）。

## 2. 目标布局

### 2.1 总体

```text
packages/model/src/
  contract/     provides.ts（产品面：登记 14 个类上方接口，直接声明内核能力服务接口）、requires.ts（注入面 14 个）、constants.ts（常量表）
  types/        model.ts（可移植）、adapters.ts、requests.ts、providers.ts、scripts.ts
  impl/
    composition/  ModelRuntimeComposition、AgentModelResolver、AgentModelRuntime、ModelAdapterRegistry、ModelKernelCapability
    requests/     ModelRequestClient、AiSdkModelRequestTransport、ModelProfiles、ModelProviderRetry、ModelUsage
    adapters/     ModelAdapter（基类）、OpenAIModelAdapter、OpenAICompatibleModelAdapter、AnthropicModelAdapter、GoogleModelAdapter、
                  DeepSeekModelAdapter、VelarModelAdapter、ProviderScriptModelAdapter、UserJsModelAdapter、PromptCacheLanguageModel、ThinkingDepthLanguageModel
    providers/    ModelProviderCollection、ModelCatalog、ModelEnvironment、ProviderScriptRegistry、VelarCloudModelRuntime、
                  ProviderModelCatalogService、ProviderModelCatalogCache
  utils/
    catalog/      provider-catalogs.ts、context-windows.ts、model-selection.ts、embedding.ts
    wire/         prompt-cache.ts、reasoning.ts、openrouter.ts、fetch-shims.ts、request-policy.ts
    scripts/      provider-scripts.ts、user-adapter.ts、selection.ts
    catalog-http.ts、resolution.ts、retry.ts、usage.ts、profiles.ts、kernel-input.ts、tuning.ts
  exports/      index.ts（Node 宿主）、contracts.ts（可移植）、catalog.ts（browser-safe 目录）
```

### 2.2 分层（从上到下；登记表 `layers`）

1. `composition/`、`requests/`：装配、解析、内核能力；通用请求客户端与产品共用机制（两组互不引用）。
2. `adapters/`：各厂商适配器与两个 LanguageModel 包装类。
3. `providers/`：provider 集合、静态目录 API、环境快照、script 注册表、Cloud 绑定、远端目录服务与缓存。

实测依赖方向允许这样分：适配器只经 `ModelProviderCollection`、`ProviderScriptRegistry`、`VelarCloudModelRuntime`、`ModelEnvironment` 取 key/baseURL/脚本/绑定；`ProviderScriptModelAdapter` 从注册表文件搬出后，`providers/` 不再引 `adapters/`（现在 `ProviderScriptRegistry.ts` 同时装着适配器子类，是唯一的反向引用）。

### 2.3 `types/`

| 文件 | 内容 | 出包 |
| --- | --- | --- |
| `model.ts`（可移植） | provider id 家族（`ChatProviderId`，内置 id 从常量表 `import type` 派生）、`ThinkingDepth`、`ReasoningLevel`、`ModelInputModality`、`AgentProviderAdapterConfig`、`ProviderScriptManifest`、`AgentProviderRuntimeConfig`、OpenRouter 路由配置、`ModelRequestPolicy`、`ModelRequestOptions`、`ModelSelection`、`ModelRuntimeContext`、`ListProviderModelsRequest`、`ValidateProviderRuntimeRequest`、`ProviderModelCatalog(Entry)`、`ModelProviderManifest`、`ModelProviderPreset`、`ProviderModelResolution`、`ProviderScriptRuntimeMetadata`、`ModelPricingCatalog/Entry/Rates`、`ModelRunUsage`、`ModelUsageSummary`、`ModelProviderRetryOptions/Decision`、`ModelProfileCredentialSource` | 整个随 `./contracts` |
| `adapters.ts` | `ModelAdapterConfig`、`LanguageModelFactory`（引 `ai` 类型）、`EmbeddingRequest`（带 `execute` 函数成员）、`ResolvedAgentModelRuntime` | 公开签名用到，从根入口出 |
| `requests.ts` | 由 `ai` 的 `generateText/streamText/Output` 推导的请求形状（原 `ModelRequestTypes.ts` 去掉 transport 接口） | 公开签名用到的出 |
| `providers.ts` | `SharedProviderCatalog`、`ProviderModelDefinition`、可用性判定入参、远端目录请求与条目、缓存条目 | 不出包 |
| `scripts.ts` | `LoadedProviderScript`、dev.json 形状、用户 JS adapter 的 VM 描述符与上下文形状 | 不出包 |

`InjectedChatProviderId` 现在用 `declare const InjectedChatProviderIdBrand: unique symbol` 做品牌，这是一个值声明，types 不许有值；改成 `string & { readonly __velarosInjectedProviderId: true }` 纯类型品牌（结构等价，下游只拿它当类型用）。

### 2.4 `utils/` 与 `tuning.ts`

| 文件 | 内容（来源） |
| --- | --- |
| `catalog/provider-catalogs.ts` | 20 个 provider 的静态目录与 OpenRouter 精选列表（`ModelCatalog.ts:69-381`，规则数据，改名单和改规则一起审） |
| `catalog/context-windows.ts` | 候选名展开、按 provider 查窗口、script 元数据窗口优先级（`ModelCatalog.ts:815-994`、`ProviderScriptContextWindow.ts` 全部） |
| `catalog/model-selection.ts` | 可见模型、建议模型、同 provider 回退（`ModelCatalog.ts:996-1057`）、OpenAI 专属模型名单 |
| `catalog/embedding.ts` | 默认 embedding 模型表、候选打分、按用途过滤（`EmbeddingModelSelection.ts`） |
| `wire/prompt-cache.ts` | 出线前翻译 `velaros` 标记成 `anthropic.cacheControl` / `openai.promptCacheKey`（`PromptCacheModelOptions.ts:150-385` 中的翻译半边；写标记的四个函数删除） |
| `wire/reasoning.ts` | 力度、预算、OpenRouter reasoning 合并、各家推理模型名匹配、`injectVelarThinkingRouting`（`ThinkingDepthModelOptions.ts` 函数部分、`VelarModelAdapter.ts:21-45`、`OpenAIModelAdapter.ts:36-44`） |
| `wire/openrouter.ts` | 路由归一、auto-router 插件合并、provider 偏好合并（`OpenAIModelAdapter.ts:110-264` 不用实例状态的部分） |
| `wire/fetch-shims.ts` | 去掉空 Bearer、注入 Ollama `num_ctx`、识别 chat/completions（`OpenAICompatibleModelAdapter.ts:79-131`） |
| `wire/request-policy.ts` | `applyModelRequestPolicy` |
| `scripts/provider-scripts.ts` | manifest / 模型 / 运行时元数据的归一、定义形状守卫、注入 id 规则、dev.json 解析与候选路径 |
| `scripts/user-adapter.ts` | VM 上下文、安全 console、函数硬化、描述符与字符串表归一 |
| `scripts/selection.ts` | `AgentModelRuntime` 的 12 个 `parse*` |
| `catalog-http.ts` | 远端 `/models` 请求构造、响应解析、错误归一 |
| `resolution.ts` | 回退轨迹、不可用错误、请求选项分层合并 |
| `retry.ts`、`usage.ts`、`profiles.ts` | 三个产品共用机制的纯函数 |
| `kernel-input.ts` | 内核 wire 入参解析（改用 zod 严格 schema，见总纲 S2） |
| `tuning.ts` | `ModelTuning`（下表） |

`ModelTuning`（全部来自现在散写的数字）：

| 组 | 项 | 现值 | 来源 |
| --- | --- | --- | --- |
| catalog | `requestTimeoutMs` / `cacheTtlMs` / `errorCacheTtlMs` / `cacheEntries` / `errorMessageChars` / `googlePageSize` | 15000 / 300000 / 30000 / 128 / 160 / 1000 | `ProviderModelCatalogService.ts:61,310,515`、`ProviderModelCatalogCache.ts:40,50` |
| scripts | `runtimeMetadataTimeoutMs` | 15000 | `ProviderScriptRegistry.ts:178` |
| userAdapter | `executionTimeoutMs` / `evaluationCacheEntries` | 1000 / 16 | `UserJsModelAdapter.ts:89-90` |
| reasoning | `budgetFast/Balanced/Deep`、`budgetMin`、`budgetMax`、`budgetMaxDeep`、`budgetRatio`、`fastMultiplier`、`deepMultiplier`、`ultraFloor`、`ultraCeil`、`ultraRatio` | 2048/4096/8192、1024、8192、12000、0.35、0.5、1.5、16000、24000、0.6 | `ThinkingDepthModelOptions.ts:16-24,113-132` |
| retry | `initialDelayMs` / `maxDelayMs` / `messageChars` | 2000 / 30000 / 180 | `ModelProviderRetry.ts:13-14,176` |
| profiles | `connectionProbeTimeoutMs` | 20000 | `ModelProfiles.ts:59` |

算法与格式里的数字就地写：FNV 种子与素数、缓存键前缀 48 字符、错误事实最多追 4 层、上下文窗口家族表。`DefaultModelContextWindow = 128_000` 只被死函数 `resolveModelContextWindow` 用，随它删。

### 2.5 `exports/`：三个入口

| 入口 | 给谁 | 内容 | 为什么不止 `.` 与 `./contracts` |
| --- | --- | --- | --- |
| `.` | Node 宿主（Desktop/Workbench/Termel 主进程） | `export * from './contracts.js'`；产品面全部实例与工厂；注入面；公开签名用到的 `types/adapters.ts`、`types/requests.ts` | — |
| `./contracts` | 任何进程 | 常量表 + `types/model.ts` | 标准入口 |
| `./catalog` | 渲染进程 | `export * from './contracts.js'` + `modelCatalog: ModelCatalogApi` | 渲染进程要清单与目录逻辑（建议模型、同 provider 回退、Ollama 可见模型），而根入口的装配链带 `node:vm`/`node:fs`；Desktop 已有两道检查只放行 `/catalog` 与 `/contracts`。登记 `browserSafeEntries: ['contracts.ts', 'catalog.ts']` |

### 2.6 逐个现有文件的去处

| 现有文件 | 去处 | 理由 |
| --- | --- | --- |
| `AgentModelResolver.ts` | `impl/composition/AgentModelResolver.ts`（类上方 `AgentModelResolverApi`）；5 个不用实例的私有方法 → `utils/resolution.ts`；`ResolvedAgentModelRuntime` → `types/adapters.ts`；`UnknownModelInputModalities` → `utils/catalog/model-selection.ts` | 一类一文件；Desktop 12 个文件拿它当类型，接口化后换 `AgentModelResolverApi` |
| `AgentModelRuntime.ts` | `impl/composition/AgentModelRuntime.ts`（`AgentModelRuntimeApi`）；12 个 `parse*` → `utils/scripts/selection.ts` | 模块级函数只许是工厂 |
| `AiSdkModelRequestTransport.ts` | `impl/requests/`，实现注入面的 `ModelRequestTransport`；`AiSdkModelRequestTransportOptions` 以类名开头，留在类文件 | 默认 transport |
| `AnthropicModelAdapter.ts`、`GoogleModelAdapter.ts`、`DeepSeekModelAdapter.ts`、`OpenAIModelAdapter.ts`、`OpenAICompatibleModelAdapter.ts`、`VelarModelAdapter.ts`、`UserJsModelAdapter.ts` | `impl/adapters/` 各一个文件，都实现注入面的 `ModelProviderAdapter`；私有纯函数 → `utils/wire/*`、`utils/scripts/user-adapter.ts`；`UserJsModelAdapter` 的 VM `Script` 常量改 `private static readonly` | 一类一文件；接口统一 |
| `ModelAdapter.ts` | `impl/adapters/ModelAdapter.ts`（抽象基类，`implements ModelProviderAdapter`）；`ModelAdapterConfig`、`EmbeddingRequest`、`LanguageModelFactory` → `types/adapters.ts` | 基类不出包，扩展点换成接口（拍板项 D5） |
| `ModelAdapterRegistry.ts` | `impl/composition/ModelAdapterRegistry.ts`（类上方 `ModelAdapterRegistryApi`，provides 登记）；`createModelAdapterRegistry` 改成组合对象内部构造；`createLegacyModelAdapterRegistry` 删 | 唯一外部用户是 consumer 测试 |
| `ModelAdapterRegistryPort.ts` | 删；接口并入上一行的 `ModelAdapterRegistryApi` | 一个概念两个名字（还有 `ModelRegistryPort` 第三个名字） |
| `ModelCatalog.ts` | 数据 → `utils/catalog/provider-catalogs.ts`；查表函数 → `utils/catalog/context-windows.ts`、`model-selection.ts`；公开 id 与默认模型表 → `contract/constants.ts`；对外函数 → `impl/providers/ModelCatalog.ts`（类 `ModelCatalog` 实现 `ModelCatalogApi`，实例 `modelCatalog` 从 `./catalog` 出）；`KnownTeamModelCapabilityOverrides`、`ModelCapabilityProfile`、`ReadonlySetSnapshot`、`OpenAiOnlyModels`（对外）、`KnownModelContextWindows`（对外）、3 个死函数 删 | 1,062 行的混合文件；353 行死数据 |
| `ModelContracts.ts`、`ModelPricing.ts` | `types/model.ts` | 可移植数据 |
| `ModelProfiles.ts` | `impl/requests/ModelProfiles.ts`（`ModelProfilesApi`，实例 `modelProfiles`）+ `utils/profiles.ts`；四个 Port 接口删 | Termel 用的四个函数变成实例方法；四个 Port 零消费 |
| `ModelProviderCollection.ts` | `impl/providers/ModelProviderCollection.ts`（`ModelProviderCollectionApi`）；`ModelProviderPreset` → `types/model.ts`；可用性入参 → `types/providers.ts`；`ModelProviderCollectionOptions` 以类名开头留在文件；新增 `defaultEmbeddingModel`、`isEmbeddingCapable` 两个方法（吸收 `EmbeddingModelSelection` 的两个带集合的函数） | 一类一文件；embedding 判定本来就要显式收集合 |
| `ModelProviderRetry.ts` | `impl/requests/ModelProviderRetry.ts`（`ModelProviderRetryApi`，实例 `modelProviderRetry`）+ `utils/retry.ts`；类型 → `types/model.ts` | Termel 用 |
| `ModelRequestClient.ts` | `impl/requests/ModelRequestClient.ts`（`ModelRequestClientApi`，工厂 `createModelRequestClient`）；选项 → `contract/requires.ts` 的 `CreateModelRequestClientOptions` | 类不出包 |
| `ModelRequestPolicy.ts` | `utils/wire/request-policy.ts` | 纯函数 |
| `ModelRequestService.ts` | 删 | 弃用别名；Desktop 1 处改 `ModelRequestClientApi` |
| `ModelRequestTypes.ts` | 请求形状 → `types/requests.ts`；`ModelRequestTransport` → `contract/requires.ts` | transport 是宿主可替换的注入点 |
| `ModelRuntimeComposition.ts` | `impl/composition/ModelRuntimeComposition.ts`（`ModelRuntimeCompositionApi`，工厂 `createModelRuntimeComposition`）；`CreateModelRuntimeCompositionOptions` → requires；`DefaultModelRuntimeComposition` 与值别名 `ModelRuntimeComposition` 删 | 接口里的成员从具体类改成接口 |
| `ModelUsage.ts` | `impl/requests/ModelUsage.ts`（`ModelUsageApi`，实例 `modelUsage`）+ `utils/usage.ts` | Termel 用 |
| `LocalModelEnvironment.ts`、`NodeLocalModelEnvironment.ts` | 合成 `impl/providers/ModelEnvironment.ts`（`ModelEnvironmentApi`，构造收快照或 `ModelEnvironmentPort`）；`process.env` 只在 `ModelRuntimeComposition` 里读一次；`OllamaProviderId`、`OllamaEnvNames` → constants（后者并进环境变量表）；`ModelEnvironmentPort` → requires；四个函数式兼容 API → `modelCatalog` 的方法 | `DelegatingModelEnvironment` 与 Node 子类都只是换数据来源 |
| `PromptCacheModelOptions.ts` | 包装类 → `impl/adapters/PromptCacheLanguageModel.ts`；翻译函数 → `utils/wire/prompt-cache.ts`；写标记的 `createPromptCacheSystemMessage`、`markLatestUserMessagePromptCacheBreakpoint`、`mergeSessionPromptCacheProviderOptions`、`resolveSessionPromptCacheKey` 删 | 写标记是 agent 的职责（agent 自有一份），本包这份零消费 |
| `ThinkingDepthModelOptions.ts` | 包装类 → `impl/adapters/ThinkingDepthLanguageModel.ts`；函数 → `utils/wire/reasoning.ts` | 同上 |
| `ProviderManifest.ts` | 21 条清单 → `contract/constants.ts` 的 `ModelProviderOperationalManifests`（冻结字面量，env 名引环境变量表）；provider 分组 → constants；形状 → `types/model.ts`；`getModelProviderOperationalManifest` → `modelCatalog.manifest`；`getModelProviderIdsByAdapterKind` 删 | 对外承诺的清单 |
| `ProviderModelCatalogCache.ts` | `impl/providers/`（类上方 `ProviderModelCatalogCacheApi`） | — |
| `ProviderModelCatalogService.ts` | `impl/providers/`（`ProviderModelCatalogApi`，只经组合对象取得）；纯函数 → `utils/catalog-http.ts`；`ProviderModelCatalogAttribution` 与选项 → requires | 产品各 `new` 一份导致缓存与请求归属分裂 |
| `ProviderRawStreamText.ts` | 删 | 零消费，agent 自有且已分叉 |
| `ProviderRuntimeAvailability.ts` | 删 | 四个函数全是 `providerCollection.x(...)` 的转发，产品零调用 |
| `ProviderScriptContextWindow.ts` | `utils/catalog/context-windows.ts` | 纯函数；入口零消费 |
| `ProviderScriptRegistry.ts` | 注册表 → `impl/providers/ProviderScriptRegistry.ts`（`ProviderScriptRegistryApi`，另有以类名开头的包内接口 `ProviderScriptRegistryScripts` 给适配器取脚本）；`ProviderScriptModelAdapter` → `impl/adapters/`；纯函数 → `utils/scripts/provider-scripts.ts`；脚本作者契约（`ProviderScriptDefinition/Input/RuntimeInput/Helpers/HostBridge`）→ requires；`fetchTavily` 删 | 一类一文件；作者契约是扩展点 |
| `ProviderScriptRegistryPort.ts` | 删；端口并入 `ProviderScriptRegistryApi`；`ProviderScriptDescriptor`、`ProviderScriptRuntimeMetadata` → `types/model.ts`；`toPositiveInteger` → `utils/scripts/provider-scripts.ts` | — |
| `VelarCloudModelRuntime.ts` | `impl/providers/`（`VelarCloudModelRuntimeApi` 只放宿主用的注册、注销、查询；`VelarModelAdapter` 取绑定用以类名开头的包内接口 `VelarCloudModelRuntimeLookup`）；`VelarCloudManagedProviderIds` → constants；`isVelarCloudManagedProviderId` → utils；`velarCloudModelRuntime` 单例与弃用的 `register` 删；`VelarCloudModelRuntimeBinding` → requires | — |
| `EmbeddingModelSelection.ts` | `utils/catalog/embedding.ts` + `ModelProviderCollection` 两个新方法；`resolveAutoEmbeddingSelection`、`selectEmbeddingModelCandidate`（对外）、`filterEmbeddingModelCandidates`（对外）不出包 | 只有 `resolveDefaultEmbeddingModelForProvider` 有产品用户 |
| `kernel-module.ts` | `impl/composition/ModelKernelCapability.ts`（类实现 provides 里直接声明的 `ModelRuntimeCapabilityService`，文件末尾工厂 `createModelKernelModule`）；入参解析 → `utils/kernel-input.ts`；`ModelRegistryPort` 别名删；128 → constants | — |
| `index.ts`、`contracts.ts`、`catalog.ts` | `exports/index.ts`、`exports/contracts.ts`、`exports/catalog.ts` | 只转发 |
| `node.ts`、`provider-scripts/node.ts` | 删 | 并进 `.` |
| `velaros-globals.d.ts` | 留在 `src/` 根 | 与 system 相同 |

## 3. 合同草案

### 3.1 `contract/provides.ts`

登记的类上方接口（成员按真实消费方收窄，括号里是依据）：

```ts
/** 一个宿主独占的模型运行时对象图；createModelRuntimeComposition(options) 创建。成员名不变，类型从具体类改成接口。 */
interface ModelRuntimeCompositionApi {
  readonly providerCollection: ModelProviderCollectionApi
  readonly providerScriptRegistry: ProviderScriptRegistryApi
  readonly velarCloudRuntime: VelarCloudModelRuntimeApi
  readonly modelAdapterRegistry: ModelAdapterRegistryApi
  readonly agentModelResolver: AgentModelResolverApi
  readonly agentModelRuntime: AgentModelRuntimeApi
  readonly providerModelCatalogService: ProviderModelCatalogApi   // 产品不再自己 new
  readonly localModelEnvironment: ModelEnvironmentApi
}
interface ModelProviderCollectionApi {          // Desktop 11 个文件；方法是实际调用过的 + 装配要用的
  listPresets(); listOperationalManifests(); requireOperationalManifest(p); requireCatalog(p)
  resolveModelSelection(p, model?); resolveModel(p, model?)
  getApiKeyEnvironmentName(p); resolveApiKey(sel); requireApiKey(sel); resolveBaseURL(sel)
  getDefaultRuntimeConfig(p); normalizeRuntimeConfigs(cfgs); findRuntimeConfig(cfgs, p); isRuntimeConfigured(input)
  getProviderIdsByAdapterKind(kind)             // 装配适配器用
  defaultEmbeddingModel(p); isEmbeddingCapable(p) // 取代两个带集合参数的函数
}
interface ProviderScriptRegistryApi {           // Desktop: configureHost、validateProviderRuntime、supportsProvider；插件链: registerSource
  configureHost(bridge); configureSources(opts); reload(); registerSource(input); unregisterProvider(p)
  supportsProvider(p); getActiveConfigPath(); getProviderScript(p): Nullable<ProviderScriptDescriptor>
  listProviderManifests(); validateProviderRuntime(req); listProviderModels(req); resolveRuntimeMetadata(cfg, model, signal?)
}
interface VelarCloudModelRuntimeApi { registerProvider(id, binding); unregisterProvider(id); hasProvider(id) }
interface ModelAdapterRegistryApi { supportsProvider(p); createLanguageModelFactory(cfg); createEmbeddingRequest(cfg, model, texts) }
interface AgentModelResolverApi { resolve(selection, runtimeContext, signal?): Promise<ResolvedAgentModelRuntime> }
interface AgentModelRuntimeApi { createAgentProvider(selection: unknown); resolveRoleRuntime(selection: unknown, ctx?: unknown, signal?) }
interface ProviderModelCatalogApi { listProviderModels(req, signal?); resolveModelCapabilities(req, signal?); invalidateProviderModels(req?); setAttribution(a) }
interface ModelEnvironmentApi { read(name); resolveOllamaBaseURL(def); resolveOllamaChatModel(def?); resolveOllamaContextWindow(def?); resolveOllamaVisibleChatModels(def?, selected?) }
interface ModelRequestClientApi { generateText(input); streamText(input, options?); generateObject(input); generateDecodedObject(input); collectTextStream(input) }
interface ModelCatalogApi {                     // browser-safe，实例 modelCatalog 从 ./catalog 与 . 出
  manifest(p); suggestedModels(p); visibleModels(p, models); resolveModel(p, current?); resolveModelSelection(p, current?)
  isOpenRouterCompatible(p); contextWindow(p, model)
  resolveOllamaBaseURL(def, env?); resolveOllamaChatModel(def?, env?); resolveOllamaVisibleChatModels(def?, selected?, env?)
}
interface ModelProfilesApi { credentialSource(input); credential(input); omitCredential(profile); runConnectionProbe(op, signal?, timeoutMs?) }
interface ModelProviderRetryApi { plan(error, options); wait(delayMs, signal) }
interface ModelUsageApi { normalizeRunUsage(value, pricing?); normalizePersistedUsage(value); summarize(usages) }
```

没有类的公开接口（直接声明）：`ModelRuntimeCapabilityService extends KernelCallableCapabilityService, ModelAdapterRegistryApi`。

对外的值（按接口标注类型）：`createModelRuntimeComposition`、`createModelRequestClient`、`modelCatalog`、`modelProfiles`、`modelProviderRetry`、`modelUsage`、`createModelKernelModule`、`ModelCapability`。

### 3.2 `contract/requires.ts`

| 注入点 | 谁给、何时、必须 |
| --- | --- |
| `CreateModelRuntimeCompositionOptions` | 宿主创建组合对象时；可选：`environment`（缺省读一次 `process.env` 快照）、`providerScripts`、`providerCatalog: { fetch?, timeoutMs?, attribution? }`、`adapters?: readonly ModelProviderAdapter[]`（新，拍板 D5）。删掉 `velarCloudRuntime` 注入（只有测试用，组合对象自己持有） |
| `ProviderScriptRegistryOptions`、`ProviderScriptHostBridge` | 宿主给 script 注册表：配置来源、`openExternal / getUserDataPath / getAppVersion` |
| `ProviderScriptDefinition`、`ProviderScriptInput`、`ProviderScriptRuntimeInput`、`ProviderScriptHelpers` | 受信 provider script 作者实现的契约（扩展点）；去掉 `fetchTavily` |
| `ModelProviderAdapter` | 自定义适配器扩展点（`supports / createLanguageModelFactory / createEmbeddingRequest`），内置适配器也实现它 |
| `ModelRequestTransport`、`CreateModelRequestClientOptions` | 宿主可替换的请求 transport；`generateText / streamText` 注入（Desktop 辅助任务在用） |
| `VelarCloudModelRuntimeBinding` | 宿主登录 Cloud 后注册：`baseURL` 与带账户认证的 `fetch` |
| `ModelEnvironmentPort` | 可移植宿主只暴露想给的环境变量 |
| `ProviderModelCatalogAttribution` | OpenRouter 的 Referer / Title |
| `CreateModelKernelModuleOptions` | `registry: ModelAdapterRegistryApi`，挂进内核时必须 |

没有工具，所以没有宿主端口，登记表不填 `toolsFile / toolDefiner / hostPort`（与 platform 同）。

### 3.3 `contract/constants.ts`

- 身份：`ModelCapabilityId = 'velaros.model'`、`ModelKernelModuleId = 'velaros.model.registry'`、`ModelKernelModuleVersion`。
- provider：`ModelProviderOperationalManifests`（21 条冻结字面量）、`ModelProviderGroups`（`openRouterCompatible`、`directOpenAICompatible`）、`CustomModelProviderIds`、`VelarCloudManagedProviderIds`、`OllamaProviderId`、`OpenRouterAutoModelId`、`OpenRouterFreeModelId`、`VelarAutoModelId`、`DefaultProviderModels`（字面量表，现在由目录计算，改成直接写并由测试核对与目录一致）、`ModelProviderAdapterKinds`、`ModelProviderValidationKinds`、`ThinkingDepths`、`ReasoningLevels`、`ModelInputModalities`。
- `ModelErrorCodes`（新，拍板 D4）：`providerUnknown`、`providerUnavailable`、`credentialMissing`、`adapterMissing`、`providerScriptInvalid`、`customAdapterInvalid`、`cloudNotConnected`、`embeddingUnsupported`；通用码沿用 core（`VALIDATION`、`NETWORK`、`TIMEOUT`、`UNAVAILABLE`）。
- `ModelEnvironmentVariables`：`VELAROS_OLLAMA_BASE_URL`、`VELAROS_OLLAMA_CHAT_MODEL`、`VELAROS_OLLAMA_CONTEXT_WINDOW`（input），`OLLAMA_HOST` 与 14 个厂商 key 变量（`OPENAI_API_KEY`… `OPENAI_COMPATIBLE_GATEWAY_API_KEY`，input，清单的 `defaultApiKeyEnv` 引这里）。门禁只核 `VELAROS_*`，其余一并登记是为了「环境变量也是注入」有一张完整的表。
- `ModelWireLimits`：`providerIdChars: 128`。

### 3.4 要删的现有导出与替代

| 现有 | 替代 |
| --- | --- |
| `./node`、`./provider-scripts/node`、`./profiles`、`./provider-retry`、`./usage`、`./ProviderScriptContextWindow` 六个入口 | 并进 `.` |
| `new ModelRequestClient(opts)`、`ModelRequestService`、`ModelRequestServiceOptions` | `createModelRequestClient(opts)`，类型 `ModelRequestClientApi` |
| `new ProviderModelCatalogService(opts)` | `composition.providerModelCatalogService`；归属用 `setAttribution` |
| `DefaultModelRuntimeComposition`、值 `ModelRuntimeComposition` | `createModelRuntimeComposition`；类型 `ModelRuntimeCompositionApi` |
| `new ProviderScriptRegistry(opts)`（Desktop 测试） | `createModelRuntimeComposition({ environment: {}, providerScripts: opts }).providerScriptRegistry` |
| `ModelAdapter`、`ModelAdapterRegistry`、`createModelAdapterRegistry`、`createLegacyModelAdapterRegistry`、7 个适配器类、`VelarModelAdapter` | 扩展走 `ModelProviderAdapter` 注入或 provider script |
| `AgentModelResolver`、`AgentModelRuntime`、`ModelProviderCollection`、`VelarCloudModelRuntime`、`LocalModelEnvironment`、`NodeLocalModelEnvironment`（作为类） | 对应 `…Api` 接口，从组合对象取实例 |
| `ModelAdapterRegistryPort`、`ModelRegistryPort` | `ModelAdapterRegistryApi` |
| `getModelProviderOperationalManifest`、`getResolvedProviderModel`、`getSharedProviderSuggestedModels`、`getVisibleProviderModels`、`isOpenRouterCompatibleProvider`、`resolveProviderModelSelection`、`resolveOllama*` 四个 | `modelCatalog.manifest / resolveModel / suggestedModels / visibleModels / isOpenRouterCompatible / resolveModelSelection / resolveOllama*` |
| `resolveDefaultEmbeddingModelForProvider(collection, p)` | `collection.defaultEmbeddingModel(p)` |
| `resolveModelProfileCredential(Source)`、`omitModelProfileCredential`、`runModelConnectionProbe`、`planModelProviderRetry`、`waitForModelRetry`、`normalize*Usage`、`summarizeModelUsage` | `modelProfiles.* / modelProviderRetry.* / modelUsage.*` |
| 死导出 13 个 + 只在包内用的 109 个 | 不出包 |
| `velarCloudModelRuntime`、`VelarCloudModelRuntime.register` | 删 |

## 4. 工具面

本包没有模型面工具。内核可调用操作只有一个 `supports_provider`（入参恰好一个 `provider` 键），`reason` 是英文，改中文；入参解析改成 zod 严格 schema（与 agent 的 `parseToolWireInput` 同一套，见总纲 S2）。另外，内核能力服务在 `invoke` 之外把注册表的三个方法直接挂在服务对象上，绕过了 wire 入参门与权限元数据——同进程宿主要用，保留但写进卡片「非目标」：wire 面只开 `supports_provider`，进程内直调由持有服务的宿主负责。

## 5. 实现层缺陷（全部实测，探针 `plan-mid/probes/model-probes.ts`）

| # | 位置 | 现象 | 复现 |
| --- | --- | --- | --- |
| M1 | `AgentModelResolver.ts:247-251`（`createThinkingDepthProviderOptions(..., input.thinkingDepth ?? 'balanced')`）、`OpenAIModelAdapter.ts:81,178`（OpenRouter 只传 `thinkingDepth`）、`AnthropicModelAdapter`/`GoogleModelAdapter`（只传 `thinkingDepth`） | `ModelAdapterConfig.reasoningLevel` 的注释说「存在时优先于 thinkingDepth 决定 reasoning 开关/力度/预算」，但只有 Velar 与 provider script 认它。选「关」时 Anthropic 仍发自适应思考、OpenAI 仍发 `reasoningEffort: medium`；`ultra` 对这几家也不抬预算 | `resolveRoleRuntime({provider:'anthropic', model:'claude-sonnet-4-6', reasoningLevel:'off'})` → `providerOptions = {"anthropic":{"sendReasoning":true,"thinking":{"type":"adaptive",…},"effort":"medium"}}`；`openai`/`gpt-5.5` → `{"openai":{"reasoningEffort":"medium","reasoningSummary":"auto"}}` |
| M2 | `ProviderScriptRegistry.ts:230-248,436-440`（`configureHost / configureSources / reload` 都走 `resetLoadedState()` 清空 `scripts`） | `registerSource()` 注册的内存脚本（注释说是插件安装链的入口）在任何一次重配后静默消失，只能重装 | `registerSource(...)` → `supportsProvider = true`；`configureHost({})` → `false` |
| M3 | `VelarModelAdapter.ts:85-107` | 聊天走宿主注入的带账户认证 `fetch`，embedding 却只返回 `{ url, headers: { Authorization: 'Bearer velar-managed' } }`、没有 `execute`；Desktop `plugins/lancedb/main/MemoryVectorBackend.ts:106-112` 于是用普通 HTTP 客户端发出去，不带账户认证 | 注册 `velaros` 绑定（带计数的 fetch）后 `createEmbeddingRequest({provider:'velaros'})` → `hasExecute=false`，认证 fetch 调用 0 次。修法：返回 `execute: () => runtime.fetch(url, …)` |
| M4 | `ProviderModelCatalogService.ts:414-437` | `normalizeModels` 每个模型都调一次 `getProviderPreset` → `listPresets()` 重建全部 21 个预设与目录；OpenRouter `/models` 约 350 条时是几十万次对象分配 | 代码走读；修法：循环外取一次 preset |
| M5 | 产品侧装配（Desktop `main/model/Service.ts:66`、Workbench `main/index.ts:344`） | 产品各 `new` 一个目录服务，与组合对象里 `AgentModelResolver` 用的那份不共享缓存、归属信息与失效：设置页刷新目录不影响运行时，运行时的 `/models` 请求不带 Referer/Title | 代码走读；目标布局里目录服务只能从组合对象取 |
| M6 | `ModelProviderCollection.ts:185-190` vs `VelarCloudModelRuntime.ts:41-44` | 前者只去掉一个末尾 `/`（`https://x//` → `https://x/`，再拼 `/embeddings` 成 `//embeddings`），后者去掉全部 | 小；统一用 platform 的 `trimTrailingPathTextSeparators` 同口径实现 |
| M7 | `ModelProviderCollection.ts:178-181`、`ModelAdapter.ts:89-92`、Desktop `chatSessionMessageState.ts:206` | 同一个「缺 key」两种文案，错误码都是 `VALIDATION`；Desktop 按「API Key 未配置」文字判断 | 改成 `ModelErrorCodes.credentialMissing`，Desktop 按码分支 |

## 6. 步骤与风险

每一步的全绿口径：`cd packages/model && bun test test`（67 条，只许挪位不许减；第 5 步起加 `spec/`）、`bun run --cwd packages/model typecheck`、`bun run --cwd packages/model build`、仓根 `bun run typecheck`、`bun run check:model-arch`、`bun run check:code-style`、`bun run check:host-contract-consumer`（打包 model 并编译 fixtures）、`bun run check:package-catalog`、`bun run check:public-readiness`；第 5 步加 `bun run check:module-ownership --only model`。

| 步 | 做什么 | 保持全绿 | 规模 |
| --- | --- | --- | --- |
| 1 修缺陷 | M2、M3、M4 各一个提交，带回归测试；M1 等拍板（D3）后单独提交 | 新测试先红后绿 | 约 150 行 |
| 2 整文件搬家 | `scripts/ownership/move-files.mjs` 按 2.6 表先整文件进 `impl/<域>/`、`utils/`、`types/`；入口文件进 `src/exports/`，**入口名一个不变**（`package.json` 目标改 `dist/exports/*`）；同提交改 `check:model-arch` 钉的路径、测试的相对 import | 导出名不变 → 产品不受影响 | 45 次搬家 |
| 3 拆混合文件与达标 | `move-declarations.mjs` 拆多类文件与类型；19 个类加类上方接口并逐成员写中文说明；约 40 个纯函数进 utils；`ModelTuning` 与常量表；20 处英文改中文；删死代码（先在入口保留转发名，第 4 步统一删） | 模型面无；用户可见文案变化（第 7 节 D6） | 约 2,000 行改动 |
| 4 合同与入口收口（破坏性） | 写 `contract/` 三个文件，入口收成 3 个；同提交改 `tests/model/consumer/package-api.ts`、`scripts/release/fixtures/host-contract-consumer/{consumer.ts, model-structured-output.ts}`、`test/package-entry.test.mjs`、`docs/generated/package-catalog.json`（`bun run generate:package-catalog`）；按 3.4 出迁移表；版本 0.6.4 → 0.7.0 | `check:host-contract-consumer` 与 consumer 编译 | 迁移面：Desktop 约 60 个文件（多为 import 改名），Workbench 约 20，Termel 3 |
| 5 登记治理 | `governed-modules.mjs` 加条目（`browserSafeEntries: ['contracts.ts','catalog.ts']`、`environmentTable: 'ModelEnvironmentVariables'`、`tuning: 'tuning.ts'`、三层 `layers`）；写 `MODULE.md` 十节、`spec/invariants.md`（候选见下）、`spec/acceptance.test.ts`；`check:model-arch` 里与本门禁重复的条目删掉，只留依赖方向与「根入口不读 process.env 以外的全局」 | `check:module-ownership` 零条 | — |

不变量候选：① `./catalog` 与 `./contracts` 整条链不碰 Node 模块（门禁）；② 解析只在同 provider 内回退模型，不换 provider（测试）；③ 未注册的 Cloud 服务直接报错，不回退 OpenRouter 或另一个 Velar 服务（测试）；④ `velaros` 缓存命名空间永不出线（测试）；⑤ 组合对象之间 provider script 不串（测试）；⑥ 用户 JS adapter 拿不到宿主 realm（测试，沿用现有沙箱用例）；⑦ provider script 元数据失败降级为窗口估计并写进 `fallbackReason`（测试）；⑧ `reasoningLevel: 'off'` 时任何 provider 都不发推理参数（测试，D3 通过后）。

**风险与会碰到的共享文件**：`scripts/ownership/governed-modules.mjs`（agent、text-files 同时在改，串行）、`scripts/model/check-arch-boundaries.mjs`、`tests/model/consumer/package-api.ts`、`scripts/release/fixtures/host-contract-consumer/*`（agent 第 6 步也会改同一批 fixtures）、`docs/generated/package-catalog.json`、`bun.lock`（删 `@types/json-schema` 依赖时）。根 `tsconfig.json` 没有 model 的 paths，不用改。M1 改变发给 Anthropic/OpenAI/Google/OpenRouter 的请求字节，影响前缀缓存与任何录制的请求快照，单独发版。

## 7. 需要拍板的项

- **D1 入口收口**：9 个入口 → `.`、`./contracts`、`./catalog`，按 3.4 破坏性迁移，版本 0.7.0。
- **D2 类不出包**：`new ModelRequestClient()` 等全部改工厂或从组合对象取；产品不再自建目录服务（修 M5）。
- **D3 `reasoningLevel` 语义**：`off` 对所有 provider 都不发推理参数，`ultra` 抬预算（修 M1）。会改请求字节。
- **D4 错误码表** `ModelErrorCodes`，Desktop 改按码判断「缺 key」。
- **D5 扩展点**：`ModelAdapter` 抽象基类不再出包，换成注入面接口 `ModelProviderAdapter` + 组合对象选项 `adapters`；还是干脆不开自定义适配器（第三方只走 provider script）。
- **D6 用户可见文案**：20 处英文改中文（自定义 adapter 报错、`fallbackReason`、Termel 的重试与探测提示）；「记忆会回退为文本检索」这类别的包的行为从模型报错与清单里拿掉。
- **D7 provider script 作者契约删 `fetchTavily`**（零调用；外部脚本若实现了它，多出的成员不影响加载）。
- **D8 与 agent 的镜像**：删掉本包零消费的写标记函数与 `ProviderRawStreamText` 后，剩下的缓存标记三个键名是两包之间的线协议，建议加仓库级一致性测试（agent 写出的消息经本包翻译后出线字段正确），而不是抽包。
