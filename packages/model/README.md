# @velaros-ai/model

模型域的唯一包：把宿主选的「哪一家、哪个模型、多深的思考」解析成能发请求的语言模型，再包成 `@velaros-ai/agent` 用的 `ModelDriver`，内置 provider 的清单与目录、各家 SDK 适配、受信 provider script、用户自定义 JS 适配器、Velar Cloud 连接绑定与远端模型目录都归它。Node 宿主（Desktop、Workbench、Termel 的主进程）用根入口装配，渲染进程只从 `./catalog` 拿目录与数据。

## 用法

```ts
import {
  createAiSdkModelDriver,
  createModelRequestClient,
  createModelRuntimeComposition,
  ModelErrorCodes,
  type ModelDriver,
  type ModelRuntimeContext,
  type ModelSelection,
} from '@velaros-ai/model'

// 一个宿主（或租户、隔离环境）一份对象图；环境快照与 provider script 来源都显式给
const models = createModelRuntimeComposition({
  environment: {},
  providerScripts: { configPaths: [] },
})

/** 每轮按最新设置解析一次，造出交给 @velaros-ai/agent 的模型驱动。 */
async function createDriver(
  selection: ModelSelection,
  settings: ModelRuntimeContext,
  signal: AbortSignal
): Promise<ModelDriver> {
  const resolved = await models.agentModelRuntime.resolveRoleRuntime(selection, settings, signal)
  const contextTokens = resolved.contextWindow ?? 128_000
  const outputTokens = Math.min(12_000, Math.floor(contextTokens / 4))
  return createAiSdkModelDriver({
    id: `${resolved.providerId}/${resolved.model}`,
    model: resolved.provider(resolved.model, resolved.modelRequestOptions),
    limits: { contextTokens, outputTokens, inputTokens: contextTokens - outputTokens - 4_096 },
  })
}

// 产品设置给出的选择，与各 provider 的运行配置
declare const selection: ModelSelection
declare const settings: ModelRuntimeContext
const driver = await createDriver(selection, settings, AbortSignal.timeout(30_000)).catch(
  (error: unknown) => {
    // 选中的 provider 没启用或缺配置：引导用户去设置页，本包不会换一家顶上
    if ((error as { code?: string }).code === ModelErrorCodes.providerUnavailable) return null
    throw error
  }
)

// 辅助任务直接用通用请求客户端；endpoint 是调用方自定的观测标签
const client = createModelRequestClient()
const title = await client.generateText({
  endpoint: 'my-app.commit-title',
  model: models.agentModelRuntime.createAgentProvider(selection)(selection.model),
  prompt: '给这段改动写一行提交标题：…',
})
```

渲染进程只从 `./catalog` 取目录：

```ts
import { ModelEnvironmentVariables, modelCatalog } from '@velaros-ai/model/catalog'

const suggestions = modelCatalog.suggestedModels('anthropic')
const model = modelCatalog.resolveModel('anthropic', suggestions[0])
const contextWindow = modelCatalog.contextWindow('anthropic', model) ?? 128_000

// 可移植面不读 process.env：Ollama 地址这类环境值由调用方经端口给
declare const ollamaBaseURLSetting: string | undefined
const ollamaBaseURL = modelCatalog.resolveOllamaBaseURL('http://localhost:11434', {
  read: (name) =>
    name === ModelEnvironmentVariables.ollamaBaseURL.name ? ollamaBaseURLSetting : undefined,
})
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/model` | Node | 运行时对象图 `createModelRuntimeComposition`、模型驱动 `createAiSdkModelDriver` 与请求编译器 `createProviderRequestCompiler`、通用请求客户端 `createModelRequestClient`、内核模块 `createModelKernelModule`、无状态的 `modelCatalog`、`modelProfiles`、`modelProviderRetry`、`modelUsage`，以及 `./contracts` 的全部内容 |
| `@velaros-ai/model/catalog` | 任何进程（含渲染进程） | 可移植数据加一份 `modelCatalog`：内置 provider 清单与静态目录、同 provider 内选型、上下文窗口、本机 Ollama 解析 |
| `@velaros-ai/model/contracts` | 任何进程 | 常量表（provider 清单、错误码 `ModelErrorCodes`、环境变量表）与可移植数据类型 |

## 约定

- 绝不换 provider：选中的 provider 没启用、缺凭据或没有适配器时 `resolveRoleRuntime` 抛 `ModelErrorCodes.providerUnavailable`；只在同一 provider 内回退模型，原因写在结果的 `fallbackReason` 与 `resolutionTrace`。
- 失败按 `error.code` 分支：本域的码在 `ModelErrorCodes`（缺凭据 `credentialMissing`、Cloud 未连接 `cloudNotConnected` 等），入参形状不对是 `VALIDATION`；文案只给人看。
- 一个宿主、租户或隔离执行环境各建一份对象图：没有模块级单例，provider script、Cloud 绑定与目录缓存都不跨对象图；对象图没有 `dispose`，随宿主进程存活。
- 不给 `environment` 时装配读一次 `process.env` 快照（各家 API Key 的变量名是清单里的 `defaultApiKeyEnv`）；不给 `providerScripts.configPaths` 时去工作目录与家目录的 `.velaros/dev.json` 找 provider script。
- 受信 provider script 与宿主同权执行，只从 `.velaros/dev.json` 或 `providerScriptRegistry.registerSource` 登记，来源鉴权归调用方；用户上传的 JS 适配器跑在 VM 沙箱里。
- Cloud 托管的 `velaros`、`velar-dev` 要在登录后各自 `velarCloudRuntime.registerProvider(id, { baseURL, fetch })`，退出或撤权时 `unregisterProvider`；宿主只注入带账户认证的 `fetch`，未注册就抛 `cloudNotConnected`，不回落 OpenRouter，两者也不互相顶替。
- `agentModelRuntime` 的两个方法收 `unknown` 并当场收窄，不做业务回退；`resolveRoleRuntime` 的第二个参数签名上可选，实际必须给（各 provider 的运行配置与 OpenRouter 开关）。
- `./catalog` 与 `./contracts` 不碰 Node 模块、从不读 `process.env`；根入口带 `node:vm` 与 `node:fs`，渲染进程不能加载。
- 挂进内核用 `createModelKernelModule({ registry: models.modelAdapterRegistry })`：能力 `velaros.model` 只开 `supports_provider` 一条操作，注册表必须由产品显式交进来。
- 场景的提示词、schema、超时与回退由产品里的场景 owner 组合，本包只负责 transport、请求策略与输出读取，不为新场景加方法。
