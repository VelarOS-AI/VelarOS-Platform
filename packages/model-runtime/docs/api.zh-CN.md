# `@velaros-ai/model-runtime` 接口文档

## 定位与非目标

本包提供模型 provider 清单、adapter、provider script、模型解析、请求 transport、embedding
选择和 Kernel module。它不拥有聊天 UI、Agent 执行循环、Workspace、Memory、Browser、
Desktop 配置或密钥持久化。

## 安装

```bash
npm install @velaros-ai/model-runtime
```

包以 ESM 发布并基于 AI SDK 6。默认入口可以进入浏览器、renderer 和 worker
构建；需要从磁盘加载脚本或执行用户 JavaScript 的宿主入口要求 Node.js 20 或更高版本。

## 公共入口

- `@velaros-ai/model-runtime/contracts`：纯类型契约入口，导出的 JavaScript 为空。
  UI、配置层和跨进程协议应优先从这里导入类型。
- `@velaros-ai/model-runtime/catalog`：纯 catalog 与显式环境解析入口，只包含
  `ModelCatalog`、`ProviderManifest` 和 `LocalModelEnvironment` 的公开能力。
- `@velaros-ai/model-runtime`：可移植、browser-safe 的公共 API，包含契约、catalog、
  policy、adapter、请求客户端与依赖注入端口；为 0.4.x 调用方保留兼容导出。
- `@velaros-ai/model-runtime/node`：Node 宿主的默认 composition、adapter registry、
  provider-script registry、VM adapter 和 `NodeLocalModelEnvironment`。
- `@velaros-ai/model-runtime/provider-scripts/node`：只需要 provider-script loader 时使用的
  窄 Node 入口。
- `@velaros-ai/model-runtime/ProviderScriptContextWindow`：稳定的上下文窗口兼容入口。

不应从 `dist/` 目录深层导入。

## 核心类与接口

- `ModelAdapterRegistryPort`：可移植的 adapter registry 注入契约。
- `ProviderScriptRegistryPort`：可移植的 provider-script 查询与运行时元数据契约。
- `ModelProviderCollection`：清单、catalog、凭证和 runtime config 的统一所有者。
- `LocalModelEnvironment`：不可变的显式环境快照和 Ollama 配置解析器。
- `ModelEnvironmentPort`：允许第三方宿主按需提供环境值的最小读取端口。
- `VelarCloudModelRuntime`：宿主独占的托管模型连接绑定。
- `AgentModelResolver`、`AgentModelRuntime`：把宿主选择解析成 Agent 可用运行时。
- `ModelRequestClient`：transport 无关的 text/object/stream 通用客户端。
- `ModelRequestTransport`：任意模型 SDK 或远程服务都可实现的请求端口。
- `ModelAdapter`：新增 provider adapter 的抽象基类。

以下 Node 类和工厂只从 `/node` 导出：

- `ModelRuntimeComposition`：可由宿主实现的完整对象图接口；明确公开
  `velarCloudRuntime` 注入端口，同名值保留构造兼容。
- `DefaultModelRuntimeComposition`：包提供的宿主独占默认实现。
- `ProviderScriptRegistry`：受信 provider script 的实例级注册表。
- `ModelAdapterRegistry`：按 provider 分派 language model 与 embedding adapter。
- `createModelRuntimeComposition(options)`：默认对象图工厂，保留浅冻结语义。

`ModelRequestService`
是 deprecated 的产品场景兼容类，后续会迁出 Model 包；通用请求使用
`ModelRequestClient`。

## 生命周期/并发

每个应用、租户或隔离执行环境创建一个 composition。不要跨安全边界共享
`ProviderScriptRegistry`。注册或重载 provider script 时，该实例内的后续解析可见新状态；
其他 composition 不受影响。Velar Cloud binding 同样属于 composition；流式请求的取消由
调用方提供 `AbortSignal`。

## 依赖注入

Node provider scripts 的来源目录和 host bridge 通过 `ProviderScriptRegistryOptions` 注入。
`openExternal`、用户数据目录和应用版本均是宿主能力；未注入时使用中性的安全回退，不绑定
Desktop 或 Electron。请求侧可以直接注入自定义 `ModelRequestTransport`：

```ts
const client = new ModelRequestClient({ transport })
```

`ModelProviderCollection` 不读取进程全局环境。可移植宿主通过构造参数只注入允许暴露的值：

```ts
const providers = new ModelProviderCollection(providerScripts, {
  environment: {
    OPENAI_API_KEY: applicationSecrets.openAi,
  },
})
```

`/catalog` 同样不会读取 `process.env`、`globalThis.process` 或浏览器全局变量。应用需要
Ollama 环境覆盖时，创建一个明确的环境对象：

```ts
import {
  LocalModelEnvironment,
  OllamaEnvNames,
} from '@velaros-ai/model-runtime/catalog'

const environment = new LocalModelEnvironment({
  [OllamaEnvNames.baseURL]: applicationSettings.ollamaBaseURL,
  [OllamaEnvNames.chatModel]: applicationSettings.ollamaModel,
})

const baseURL = environment.resolveOllamaBaseURL('http://localhost:11434')
const model = environment.resolveOllamaChatModel('qwen3:8b')
```

需要接入密钥服务、远程配置或沙箱变量时，可以实现 `ModelEnvironmentPort`，再通过
`LocalModelEnvironment.from(port)` 复用相同解析逻辑。只有 `/node` 中的
`NodeLocalModelEnvironment` 和默认 composition 会把 `process.env` 适配到这一端口；
传入 `createModelRuntimeComposition({ environment })` 时则只使用调用方给定的快照。

`providerScripts` 只需实现 `ProviderScriptRegistryPort`，因此浏览器可以接远程 RPC
实现，测试可以接内存实现，不需要模拟 Node 文件系统。

`VelarModelAdapter` 和标准 `createModelAdapterRegistry` 必须显式注入宿主自己的
`VelarCloudModelRuntime`。只有 deprecated 的 `createLegacyModelAdapterRegistry`
会读取 0.4.x 进程级兼容实例。

通过接口类型持有 composition 时也可以直接配置宿主独占的 Velar Cloud 连接：

```ts
import type { ModelRuntimeComposition } from '@velaros-ai/model-runtime/node'

declare const models: ModelRuntimeComposition

models.velarCloudRuntime.register({
  baseURL: 'https://model-gateway.example.com',
  fetch,
})
```

## 错误模型

未知 provider、缺失凭证、无适配器和无效 provider script 使用 `AppError`，调用方应根据
稳定的 `code` 分支。模型供应商的网络/协议错误由 transport 保留 cause 后上抛。provider
可用性检查返回布尔值，不以异常表达“尚未配置”。

## 最小第三方示例

```ts
import {
  ModelRequestClient,
  type ModelRequestLanguageModel,
  type ModelRequestTransport,
} from '@velaros-ai/model-runtime'
import {
  DefaultModelRuntimeComposition,
} from '@velaros-ai/model-runtime/node'

declare const transport: ModelRequestTransport
declare const model: ModelRequestLanguageModel

const models = new DefaultModelRuntimeComposition({
  providerScripts: {
    configPaths: ['./providers.json'],
    hostBridge: {
      getUserDataPath: () => './data',
      getAppVersion: () => '1.0.0',
      openExternal: async (url) => {
        console.info('open', url)
      },
    },
  },
})

models.velarCloudRuntime.register({
  baseURL: 'https://model-gateway.example.com',
  fetch,
})

const selection = models.providerCollection.resolveModelSelection(
  'openai',
  'gpt-5.5'
)

const client = new ModelRequestClient({ transport })
const text = await client.generateText({
  endpoint: 'my-app.summary',
  model,
  prompt: '请概括这段内容',
})

void selection
void text
```

仓库中的 [`examples/minimal.ts`](../examples/minimal.ts) 会随包发布，并在发布门禁中以
NodeNext、`skipLibCheck: false` 编译。

## 扩展点

- 继承 `ModelAdapter` 接入新的 SDK 或协议。
- 实现 `ModelEnvironmentPort` 接入应用配置、远程密钥或受控沙箱环境。
- 用 `ProviderScriptRegistry.registerSource()` 动态注入受信 provider。
- 实现 `ModelRequestTransport` 将请求转发到远程网关、测试替身或其他 SDK。
- 通过显式 `ModelProviderCollection` 复用 embedding 选择和可用性策略。

## 兼容策略

0.4.x 保留函数式 composition 工厂和命名场景请求方法。`0.4.6` 补齐
`ModelRuntimeComposition.velarCloudRuntime` 的类型声明，使公开接口与既有默认实现一致。
`velarCloudModelRuntime` 与
`createLegacyModelAdapterRegistry` 仅作为 deprecated 兼容入口保留；标准 composition、
`VelarModelAdapter` 和 `createModelAdapterRegistry` 均使用显式注入。
provider/model 选择保持显式；不会因新增 provider script 改写其他 composition。公共入口的
移除、provider id 语义变化或 transport envelope 破坏性调整只在新的主版本发生。发布声明
使用包内模块化 utility types，不注入 ambient globals，也不会与 Core/UI 的类型声明冲突。
