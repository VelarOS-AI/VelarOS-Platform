# @velaros-ai/model 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/contract/` 的三个文件（产品面登记、注入面、常量表），再看各实现文件类上方的接口。代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`、`bun run check:model-arch`。

## 这是什么

模型域唯一的包：把宿主的一次「用哪家、哪个模型、多深的思考」解析成 agent 能直接发出去的语言模型工厂，并且管着 21 个内置 provider 的清单与静态目录、各家 SDK 的适配、受信 provider script、用户上传的自定义 JS 适配器、Velar Cloud 的连接绑定，以及远端 `/models` 目录的抓取与缓存。

它**没有模型面工具**：模型不直接调它。内核那一面只开一条可调用操作 `supports_provider`。

它也不知道 agent 长什么样——agent 刻意不依赖本包，两边经宿主注入的不透明运行时对接。提示词缓存的三个标记键是两包之间的线协议：agent 写标记，本包出线前翻译成各家的线上字段，`velaros` 命名空间永不出线。

## 提供什么

`createProviderRequestCompiler`、`ProviderRequestCompilerApi`：对已物化请求编码、计量和封存 v2 审计快照。

`modelRequestEncoder` / `ModelRequestEncoderApi` 将中立请求编码为驱动实际发送的 prompt，ProviderRequestCompiler 共用此编码入口。


- `createAiSdkModelDriver`、`AiSdkDriverOptions`、`ModelDriver`：提供统一流式驱动与编码预算口径。

本包对外只有三个面，都由接口控制：导出的类型只能来自 `src/contract/`（provides 登记的接口、requires、constants）和 `src/types/` 的公开数据文件，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对，没写进这一节的值导不出去。

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `createModelRuntimeComposition` | `ModelRuntimeCompositionApi` | 一个宿主独占的模型运行时对象图；provider script、provider 集合、适配器注册表、解析器、目录服务的可变状态全在这一份上 |
| `createModelRequestClient` | `ModelRequestClientApi` | 通用请求客户端：文本、结构化输出、流式，transport 可整个替换 |
| `createModelKernelModule` / `ModelCapability` | `ModelRuntimeCapabilityService` | 挂进内核的模块与它的能力令牌 |
| `modelCatalog` | `ModelCatalogApi` | 内置 provider 的清单、静态目录、同 provider 内选型、上下文窗口查表、本机 Ollama 解析；browser-safe |
| `modelProfiles` | `ModelProfilesApi` | profile 凭据来源判定与有界连接探测 |
| `modelProviderRetry` | `ModelProviderRetryApi` | 瞬时失败的重试计划与退避等待 |
| `modelUsage` | `ModelUsageApi` | token 账本归一、合计与按单价目录查价 |

对象图上的成员也各有接口：`ProviderScriptRegistryApi`、`ModelProviderCollectionApi`（选项 `ModelProviderCollectionOptions`）、`VelarCloudModelRuntimeApi`、`ModelAdapterRegistryApi`、`AgentModelResolverApi`、`AgentModelRuntimeApi`、`ProviderModelCatalogApi`（选项 `ProviderModelCatalogServiceOptions`、缓存面 `ProviderModelCatalogCacheApi`）、`NodeLocalModelEnvironmentApi`（可移植基面 `LocalModelEnvironmentApi`）、内置 transport 的选项 `AiSdkModelRequestTransportOptions`。

**注入面**，写在 `contract/requires.ts`，是宿主要塞进来的东西。本包只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `CreateModelRuntimeCompositionOptions` | 可选 | 宿主装配对象图时给：环境快照、`ProviderScriptRegistryOptions`、`providerCatalog`（fetch / 超时 / `ProviderModelCatalogAttribution`）、自带适配器 `adapters` |
| `ModelProviderAdapter` | 可选 | 自定义适配器扩展点：宿主接一家本包没内置、又不方便写成 provider script 的服务商时实现它，排在内置适配器之前匹配 |
| `ModelRequestTransport` 与 `ModelRequestClientOptions` | 可选 | 宿主要接自己的观测、重放或假实现时替换请求 transport |
| `VelarCloudModelRuntimeBinding` | 登录 Cloud 后必须 | `baseURL` 与带账户认证的 `fetch`；聊天与 embedding 都走它 |
| `ModelEnvironmentPort` | 可选 | 可移植宿主只暴露自己愿意给的那几个环境变量 |
| `ProviderScriptHostBridge` | 可选 | provider script 要开外链、要用户数据目录与应用版本时经它拿 |
| `ProviderScriptDefinition` / `ProviderScriptInput` / `ProviderScriptRuntimeInput` / `ProviderScriptHelpers` | 受信脚本作者实现 | provider script 的作者契约；脚本以宿主同权执行，入口必须显式登记 |
| `CreateModelKernelModuleOptions` | 挂内核时必须 | 产品持有的适配器注册表 |
| 环境变量，全部登记在 `ModelEnvironmentVariables` | 可选 | 三个 Ollama 输入变量 |

**数据面**是 `types/`，只放类型；**常量表**是 `contract/constants.ts`，只放值：身份（`ModelCapabilityId`、`ModelKernelModuleId`、`ModelKernelModuleVersion`）、`ModelProviderOperationalManifests`（21 条清单）、`DefaultProviderModels`、provider 分组（`OpenRouterCompatibleProviderIds`、`DirectOpenAICompatibleProviderIds`、`CustomModelProviderIds`、`VelarCloudManagedProviderIds`）、单个 id（`OllamaProviderId`、`OpenRouterAutoModelId`、`OpenRouterFreeModelId`、`VelarAutoModelId`、`OpenAICompatibleGatewayDefaultBaseURL`、`OllamaHostEnvironmentName`）、轴表（`ThinkingDepths`、`ReasoningLevels`、`ModelInputModalities`、`ModelProviderAdapterKinds`、`ModelProviderValidationKinds`）、`ModelErrorCodes`、`ModelEnvironmentVariables`、`ModelWireLimits`。

三个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主（Desktop / Workbench / Termel 主进程） | 三个面的全部 |
| `./catalog` | 渲染进程 | 可移植数据 + `modelCatalog` 一个实例 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据类型 |

`browserSafeEntries` 是 `contracts.ts` 与 `catalog.ts`：这两条的引用链不碰 Node 内置模块，也不去发现宿主进程的环境（`check:model-arch` 逐条核对）。

## 骨干链路

本包没有模型面工具，骨干是一次模型解析与一次请求。

| 链路 | 怎么走 |
| --- | --- |
| 装配 | `createModelRuntimeComposition(options)` → 读一次环境快照 → 建 provider script 注册表（磁盘 `.velaros/dev.json` 或内存来源）→ 建 provider 集合（清单 + 目录 + 凭据）→ 建 Cloud 绑定容器 → 按顺序装适配器（宿主自带 → Cloud → provider script → Anthropic / Google / DeepSeek / OpenAI 兼容 / OpenAI / 用户 JS）→ 建远端目录服务 → 建解析器与 agent 入口 → 浅冻结交出去 |
| 解析一次选择 | `agentModelRuntime.resolveRoleRuntime(selection, ctx)` → 把 `unknown` 收窄成本域契约（只做收窄与拒绝，不做业务回退）→ `agentModelResolver.resolve` → provider 不可用就抛 `providerUnavailable` 并给自救动作，**绝不换 provider** → 只在同一个 provider 内按静态目录回退模型 → provider script 的运行时元数据失败降级成「按本地目录估窗口」并把原因写进 `fallbackReason` → 按适配器造语言模型工厂，套上提示词缓存与 reasoning 两层包装 |
| 发一次请求 | `createModelRequestClient({ transport })` → `generateText` / `generateObject` / `generateDecodedObject` / `streamText` / `collectTextStream` → 请求策略（温度、topP、输出上限）兜底合进请求 → 交给 transport（缺省是 AI SDK 那一份） |
| 列远端模型 | `composition.providerModelCatalogService.listProviderModels(req)` → 有缓存且没过期就用缓存 → 否则按 provider 拼 `/models` 请求（OpenRouter 带宿主给的 Referer / Title）→ 解析、过滤、按用途筛 → 写缓存；失败也短暂缓存，避免打穿 |
| 内核调用 | `createModelKernelModule({ registry })` → `activate` 注册能力服务 → wire 面只开 `supports_provider`，入参用 zod 严格解析，越界即拒 |

## 依赖什么

- `@velaros-ai/core`：类型守卫、缺席值、日志、`AppError`、`TimerScope` 定时器租约。
- `@velaros-ai/kernel`：内核模块定义与模块 SDK；`@velaros-ai/kernel/contracts` 出能力令牌等可移植数据。
- `ai` 与 `@ai-sdk/{openai,anthropic,google,provider}`：各家服务商的语言模型与 embedding SDK。
- Node 内置模块只出现在 provider script 注册表（fs、module、os、path、vm）与用户 JS 适配器（vm）里；`process.env` 只在 `NodeLocalModelEnvironment` 与 provider script 注册表读一次。

**不依赖 `@velaros-ai/agent`**，agent 也不依赖本包（`packages/agent/test/model-boundary.test.ts` 盯着）。两边共享的只有三件线协议：提示词缓存标记的三个键、`reasoningLevel → thinkingDepth` 的映射、请求策略字段名。

## 状态归谁

- **运行时对象图**：一个宿主一份，`createModelRuntimeComposition` 交出后浅冻结。provider script 表、provider 集合、适配器注册表、Cloud 绑定、目录缓存全挂在它下面，**没有任何模块级单例**——两份对象图之间 provider script 不串、Cloud 绑定不串。
- **provider script 表**：注册表私有，内存里。磁盘来源按配置路径加载，内存来源经 `registerSource` 进来（调用方负责来源鉴权），重配时磁盘那份重载、内存那份保留。
- **远端目录缓存**：目录服务私有，内存里，按 provider + 鉴权作用域分键，成功与失败分别有各自的 TTL 与条数上限（见 `utils/tuning.ts`）。
- **Cloud 绑定**：绑定容器私有；宿主登录后注册，登出后注销。
- **四个无状态实例**（`modelCatalog`、`modelProfiles`、`modelProviderRetry`、`modelUsage`）：只查表与算数，不持状态，可以随便共享。
- **环境变量**：装配时读一次快照；可移植宿主经 `ModelEnvironmentPort` 按需给。本包自己从不去发现 `process.env`。

## 生命周期

- 常量表与四个无状态实例是纯值，随包加载即存在。
- 对象图由宿主创建，随宿主进程存活；没有 `dispose`——它管的都是内存态与按次发起的请求。
- provider script 在第一次读取时加载；`configureHost` / `configureSources` / `reload` 都会清掉已加载状态，下一次读取重新加载（内存来源会被重放回来）。
- 内核模块 `createModelKernelModule` 在 `activate` 时注册能力服务，`dispose` 时注销；它不造也不发现注册表，注册表必须由产品显式传进来。
- 请求客户端是纯转发对象，可以按用途建多份（例如辅助任务与主聊天各一份）。

## 失败语义

- **不换 provider。** provider 不可用一律抛 `providerUnavailable` 并给出自救动作；自动跨 provider 回退会让用户的密钥、隐私边界与账单在他不知情时改变。只在同一个 provider 内回退模型。
- **缺凭据是码，不是文案。** `ModelErrorCodes.credentialMissing`；界面按码分支，不要匹配报错文字。
- **provider script 元数据失败不阻断**：降级成按本地目录估窗口，并把原因写进 `fallbackReason` 一路带到 resolutionTrace，让用户看得见降级发生过。
- **Cloud 未连接直接报错**（`cloudNotConnected`），不回落 OpenRouter，也不换另一个 Velar 服务。
- **解析层只抛形状错**：`agentModelRuntime` 的两个方法收 `unknown`，在那里一次性收窄；收窄之后包内不再复检。
- **用户 JS 适配器跑在 VM 沙箱里**，拿不到宿主 realm；受信 provider script 则是宿主同权执行，入口必须显式登记（`.velaros/dev.json` 或插件安装链的 `registerSource`）。
- 完整错误码语义见 `src/contract/constants.ts` 的 `ModelErrorCodes`；通用失败沿用 core 的 `VALIDATION` / `NETWORK` / `TIMEOUT` / `UNAVAILABLE`。

## 不变量

共 11 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 9 条、门禁 2 条。未验证 0 条。

## 非目标

- 不做模型面工具：模型不直接调本包，内核那一面只开 `supports_provider` 一条。
- 不知道 agent：不引 agent，不复刻它的循环；两边靠线协议对接。
- 不做界面文案：缺 key、缺连接、缺脚本都只给码与事实，怎么引导用户是宿主的事。
- 不发现宿主进程：`./catalog` 与 `./contracts` 的链上不碰 Node 模块，也不读 `process.env`；要环境值就从 `ModelEnvironmentPort` 给。
- 不做模块级单例：两份对象图之间不共享任何可变状态。
- 不替宿主保管密钥：凭据从产品配置或登记过的环境变量来，本包只在出线时用一次。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记产品面（类实现的 API 定义在类上方，这里 re-export），requires.ts 注入面（含 provider script 的作者契约），constants.ts 约定的常量表
  types/        只放类型，按域分文件：model.ts 是可移植数据文件，adapters.ts / requests.ts / providers.ts / scripts.ts / script-authoring.ts / user-adapter.ts 各管一域
  impl/         按域分子目录：composition/ 装配与解析与内核能力，requests/ 请求客户端与三个共用机制，adapters/ 各厂商适配器与两层包装，providers/ provider 集合、目录、环境、脚本注册表、Cloud 绑定；一个类一个文件
  utils/        纯工具函数，按域分子目录（catalog / wire / scripts）；每个函数上方一句中文说明；tuning.ts 是全包的可调参数表
  index.ts      `.` 入口，只转发
  catalog.ts    `./catalog` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
```

**看代码的顺序**：`contract/` 的三个文件 → `impl/composition/DefaultModelRuntimeComposition.ts`（对象图怎么装起来）→ `impl/composition/AgentModelResolver.ts`（一次解析的全部判据）→ 需要时看 utils 里函数上方的一句说明。

**常量分四处。** 对外承诺的（身份、provider 清单、错误码、环境变量、wire 上限）在 `contract/constants.ts`；包内可调的（超时、缓存 TTL 与条数、思考预算、退避）在 `utils/tuning.ts` 的 `ModelTuning`；某个类里固定用的名单与环境变量名写成该类的 `private static readonly`；算法与格式里的数字就地写。

实现分三层，上层可以调下层，下层不调上层：

| 层 | 文件 | 做什么 |
| --- | --- | --- |
| 装配与请求 | `composition/`（`DefaultModelRuntimeComposition`、`AgentModelResolver`、`AgentModelRuntime`、`ModelAdapterRegistry`、`ModelKernelCapability`）、`requests/`（`ModelRequestClient`、`AiSdkModelRequestTransport`、`ModelProfiles`、`ModelProviderRetry`、`ModelUsage`） | 对象图、解析、内核能力；通用请求客户端与三个产品共用机制（两组互不引用） |
| 适配 | `adapters/`（`ModelAdapter` 基类与七个子类、`PromptCacheLanguageModel`、`ThinkingDepthLanguageModel`、`LanguageModelWrappers`） | 各厂商 SDK 的语言模型与 embedding 工厂，加两层出线包装 |
| provider | `providers/`（`ModelProviderCollection`、`ModelCatalog`、`LocalModelEnvironment`、`NodeLocalModelEnvironment`、`ProviderScriptRegistry`、`VelarCloudModelRuntime`、`ProviderModelCatalogService`、`ProviderModelCatalogCache`） | provider 清单与目录、环境快照、脚本注册表、Cloud 绑定、远端目录与缓存 |

每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下，只引 utils、types 与合同。

`contract/` 的三个文件改了等于改对外契约，要在差量报告里点名；`ModelProviderOperationalManifests` 与静态目录改了等于改用户看得到的 provider 与模型名单，也要点名。
