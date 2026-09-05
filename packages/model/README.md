# @velaros-ai/model

**模型域的唯一包**(model 域,住 `packages/model`)。它回答一件事:
**「宿主选了 provider + model,怎么变成一个能真正发请求的运行时?」**

它拥有 provider id 与清单、模型目录、鉴权与显式环境解析、OpenRouter 路由、
上下文窗口元数据、provider adapter、provider script 契约、运行时模型解析、
请求选项、embedding 模型选择、provider 运行时可用性,以及后端辅助模型请求服务。

依赖只有 `@velaros-ai/core` 与外部模型 SDK(AI SDK 6 系)。
**不依赖** Agent 执行、Workspace、Computer、System、Office、Browser、Memory 或 Desktop。

## 分区

包按**运行面**切,不按功能切——决定你该进哪个入口的是「你跑在哪」:

| 入口 | 跑在哪 | 内容 |
| --- | --- | --- |
| `@velaros-ai/model/contracts` | 任何地方 | 纯类型契约,编译后 JavaScript 为空。UI、配置层、跨进程协议优先从这里拿类型 |
| `@velaros-ai/model/catalog` | 任何地方 | 纯数据 + 纯函数:`ModelCatalog`、`ProviderManifest`、`LocalModelEnvironment` |
| `@velaros-ai/model` | browser-safe | 可移植公共 API:契约、catalog、policy、adapter、请求客户端、依赖注入端口 |
| `@velaros-ai/model/profiles` | 任何地方 | profile 凭据来源解析与脱敏投影，不读取宿主全局环境 |
| `@velaros-ai/model/provider-retry` | 任何地方 | provider 无关的瞬时错误分类、退避计划与可取消等待 |
| `@velaros-ai/model/usage` | 任何地方 | usage 归一、注入式定价与聚合原语 |
| `@velaros-ai/model/node` | Node ≥ 20 | Node 宿主装配:默认 composition、adapter registry、文件系统 provider-script registry、VM adapter、`NodeLocalModelEnvironment` |
| `@velaros-ai/model/provider-scripts/node` | Node ≥ 20 | 只要 provider-script loader 时的窄入口(自己装 composition 的宿主用) |
| `@velaros-ai/model/ProviderScriptContextWindow` | 任何地方 | 稳定的上下文窗口兼容入口 |

**不要深挖 `dist/`。**

### 为什么根入口必须 browser-safe

根入口与 `/catalog` **永不读 `process.env`**(也不读 `globalThis.process` 或浏览器全局)。
浏览器、Worker、测试、远程宿主自己 `new LocalModelEnvironment({...})`,
只放它愿意暴露的值;或者实现 `ModelEnvironmentPort` 走 `LocalModelEnvironment.from(port)`。
**唯一**把 `process.env` 适配到这个端口的地方是 `/node` 的 `NodeLocalModelEnvironment`
与默认 composition。这不是洁癖:密钥读取路径一旦有进程级兜底,
就没法保证某个 composition 看不到另一个 composition 的凭据。

## 核心概念

- **`ModelRuntimeComposition`(`/node`)** —— 对象图。一个应用 / 租户 / 隔离执行环境
  **各建一个**,里面是 `providerScriptRegistry` / `localModelEnvironment` /
  `providerCollection` / `velarCloudRuntime` / `modelAdapterRegistry` /
  `agentModelResolver` / `agentModelRuntime` 七件。
  它是接口,宿主可以自己实现;`DefaultModelRuntimeComposition` 是包提供的默认实现,
  `createModelRuntimeComposition()` 是工厂。
- **`ModelProviderCollection`** —— 清单、catalog、凭据与 runtime config 的统一所有者。
  可变的 provider-script 状态归**这一个实例**,不从进程全局兜底读。
- **`ProviderModelCatalogService`** —— 动态模型目录的 provider 协议层：统一构造
  OpenAI-compatible / OpenRouter / Anthropic / Google 的模型列表请求并归一响应。
  产品仍负责凭据存储、调用时机、IPC 与 UI 投影，并显式注入自己的 composition 与网络传输。
- **`ModelAdapter`** —— 新增 provider 的抽象基类。内置
  OpenAI / OpenAI-compatible / Anthropic / Google / DeepSeek / Velar 云
  以及两个动态形态:`ProviderScriptModelAdapter`(受信脚本)与 `UserJsModelAdapter`(用户 JS)。
- **`AgentModelResolver` / `AgentModelRuntime`** —— 把宿主的选择解析成 Agent 能直接用的运行时。
- **`ModelRequestClient` + `ModelRequestTransport`** —— transport 无关的
  text / object / stream 通用客户端。`AiSdkModelRequestTransport` 是基于 AI SDK 的默认实现;
  远程网关、测试替身、别家 SDK 各实现一份 transport 即可。
- **`LocalModelEnvironment` / `ModelEnvironmentPort`** —— 不可变的显式环境快照与最小读取端口
  (Ollama 的 baseURL / model / 上下文窗口 / 可见模型都从这里解析)。
- **`VelarCloudModelRuntime`** —— 托管模型连接绑定,**宿主独占**,属于 composition。
  `velar` 与 `velar-dev` 各自注册、各自撤销，未注册的服务会直接报错，不会跨服务或向
  OpenRouter 回退。`velar-dev` 的模型目录由 Cloud 按账户授权动态下发；Platform 将其中的
  公共模型 ID 作为不透明字符串原样传给 Cloud，不维护静态副本。该服务当前只支持
  聊天模型，embedding 不会回退到原有 Velar 链路。
- **横切选项族** —— `PromptCacheModelOptions`(前缀缓存断点)、
  `ThinkingDepthModelOptions`(推理力度 / OpenRouter reasoning 合并)、
  `ModelRequestPolicy`、`ProviderRuntimeAvailability`、`EmbeddingModelSelection`。
- **产品共用连接机制** —— `ModelProfiles` 通过显式配置、凭据库和环境快照解析 profile，
  `ModelProviderRetry` 提供 provider 无关的瞬时错误分类与可取消退避，`ModelUsage` 统一 usage
  归一和注入式价格计算。配置文件布局、安全存储、fallback 顺序与使用量展示仍由产品决定。
- **`createModelKernelModule()`** —— 把 provider 解析做成 Kernel callable capability
  (`velaros.model`)。**Kernel 从不自己创建或发现 registry**,必须由产品注入。

`ModelRequestService` 是 **deprecated** 的兼容类,只为那几个还没搬走的产品专用方法留着;
通用请求一律 `ModelRequestClient`。

## 典型用法

Node 宿主装配 + 解析一个角色运行时:

```ts
import { createModelKernelModule } from '@velaros-ai/model'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'

const models = createModelRuntimeComposition()
const modelModule = createModelKernelModule({ registry: models.modelAdapterRegistry })

await models.agentModelRuntime.resolveRoleRuntime(
  { provider: 'openai', model: 'gpt-5.5', apiKey: openAiKey, baseURL: '' },
  {
    providerRuntimeConfigs: [
      { provider: 'openai', enabled: true, apiKey: '', baseURL: '', defaultModel: 'gpt-5.5' },
    ],
    openRouter: { useFreeModelsForDebug: false },
  },
)
```

Cloud 授权模型必须按服务绑定；宿主只注入带账户认证的 Cloud `fetch`，不能把上游密钥交给
Model Runtime。`velar-dev` 的默认 enabled 只表示绑定完成后运行配置可用；账户可见性与授权
仍由宿主下发的 managed model 列表和 Cloud 服务端决定，未绑定时请求会直接失败：

```ts
models.velarCloudRuntime.registerProvider('velar-dev', {
  baseURL: `${cloudBaseURL}/v1/velar-dev`,
  fetch: authenticatedCloudFetch,
})

// 退出账户或 Cloud 撤权后立刻移除这一条绑定，不影响原有 Velar。
models.velarCloudRuntime.unregisterProvider('velar-dev')
```

可移植宿主显式注入环境(不读进程全局):

```ts
import { LocalModelEnvironment, OllamaEnvNames } from '@velaros-ai/model/catalog'

const environment = new LocalModelEnvironment({
  [OllamaEnvNames.baseURL]: settings.ollamaBaseURL,
  [OllamaEnvNames.chatModel]: settings.ollamaModel,
})
const baseURL = environment.resolveOllamaBaseURL('http://localhost:11434')
```

自带 transport:

```ts
import { ModelRequestClient } from '@velaros-ai/model'

const client = new ModelRequestClient({ transport })
const text = await client.generateText({ endpoint: 'my-app.summary', model, prompt })
```

`examples/minimal.ts` 随包发布,并在发布门禁里以 NodeNext + `skipLibCheck: false` 编译——
它是「第三方能不能独立消费本包」的可执行证据,别让它腐烂。

## 生命周期与并发

每个应用 / 租户 / 隔离执行环境**一个 composition**。
**不要跨安全边界共享 `ProviderScriptRegistry`**:注册或重载 provider script 后,
只有该实例内的后续解析看得见新状态,其他 composition 不受影响。
内置 catalog 是不可变模块数据;注入的 provider script 只在注册它的 composition 内可见。
流式请求的取消由调用方给 `AbortSignal`。

## 错误模型

未知 provider、缺凭据、无适配器、无效 provider script 一律 `AppError`,
调用方按稳定的 `code` 分支。模型供应商的网络 / 协议错误由 transport 保留 cause 后上抛。
**provider 可用性检查返回布尔值**,不用异常表达「尚未配置」。

## 边界:本包不负责什么

不拥有聊天 UI、Desktop 配置持久化、IPC 或工具注册。
宿主创建一个隔离的 composition,并把它面向 Agent 的不透明运行时注入下去。
embedding 选择与 provider 可用性辅助函数**总是显式接收** composition 的
`ModelProviderCollection`,不去找全局。AI SDK 的传输细节只许待在 `AiSdkModelRequestTransport` 里。

## 相邻包

| 包 | 关系 |
| --- | --- |
| `@velaros-ai/core` | 唯一仓内依赖:`AppError` / 类型守卫 / kernel abi |
| `@velaros-ai/agent` | 主要消费方:拿 `AgentModelRuntime` 跑执行循环 |
| `@velaros-ai/memory` | 消费 embedding 选择做向量检索 |

## 门

`check:model-arch`(依赖方向 + 包集合冻结,比对仓根 `velaros.domainVersions.model`)。
