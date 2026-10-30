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

- 支持准确派发登记的驱动声明 `dispatchAware`，准备完成后在实际调用前等待 `stream` 的第三参数；登记失败不发请求且保留宿主错误。`modelRequestDispatcher` 在旧驱动入口保守登记；`budgetRequestId` 仅用于宿主记账，不进入供应商正文或缓存键。

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

- GPT-6 Sol 通过 Responses 传递选中的推理档位，支持最高 `max`；SDK 尚未收录型号时仍按推理模型处理。
- 官方 GPT-6 Sol 与 Astra 将上游历史缓存标记传给 Responses 内容块；先保留调用方显式断点，再用默认隐式模式剩余的三个显式槽选择最近的内部标记。缓存读写量与实际费用以供应商 usage 为准。
- 原生 Responses 的完整文本输出保留加密推理、原始文本分段及消息阶段，只有同驱动、同供应商型号且正文逐字匹配才以 `store: false` 重放。密文不拼进材料文本，容量按原响应推理用量独立预留（未报告时保守取输出用量或上限），文本密度校准不缩小这部分。
- 请求编译的会话估算校准支持 `textRatio` 与可选固定开销 `overheadTokens`，结果以原始文本估算为上限；精确计数、图片和不透明状态的预留独立处理。固定开销必须是非负安全整数。驱动已标记 `calibration: 'provider-usage'` 的实测校准估算保持原值，避免再次缩小。
- 加密推理状态、签名或 `reasoning.context` 被拒时直接保留原错误，不按思考档位不兼容降档重试。
- 供应商重试分类同时读取结构化错误码和仅含一个机器码的诊断；已知的流读取、服务暂不可用和限流错误可交给调用方有限重试，鉴权、参数、额度等永久错误与取消优先。普通句子中提到某个错误码不改变分类，未知错误保留失败；重试资格不代表响应已被接受或可以执行其中的调用。
- Responses 原始失败终态独立保留错误码与文案，避免 SDK 因缺少序号等外围字段而只返回 `other`。只接受至多 128 字符的机器码和 2048 字符的诊断；无效或过长详情保持未知失败，不截断后推断重试，不接收失败响应里的产物，已报告用量照常保留。
- 内置 OpenAI Responses 收齐 `response.completed`、`response.incomplete` 或 `response.failed` 的完整 SSE 事件后结束 SDK 输入，由 SDK 按原有规则生成 usage、continuation 和最终状态；不再等待连接的无关尾流。正文原字节保持，只在终端以 CR 结束时补 LF，形成等价 SSE 分隔符。半帧和普通文本完成事件不算响应终端，单个事件超过 16 MiB 时明确失败；取消清理失败或悬挂不能改变已完整交付的终端事实。

- `createAiSdkModelDriver` 声明 `nativeTools: true`，将 `response.type: 'tools'` 的正式 schema 交给 SDK，完整调用以 `tool-call` 事件返回；执行由上层完整响应验收后派发。配对的 `toolExchange` 以供应商原生 assistant/tool 消息回传，调用与回执身份、数量和顺序必须相符。请求快照与指纹包含工具定义。
- 历史正文的 `toolResult` 标记将已展示文本直接绑定到前一条 assistant 的调用。标准驱动将原样正文放入对应工具回包，保留缓存断点并只发送一次；没有绑定正文的调用继续使用归档回执。逻辑历史、原文与容量编译仍由宿主维护。
- 启用 OpenAI 显式缓存的线路按 SDK 的实际落点传递工具结果断点：Responses 放在 output 内容块，Chat 放在结果 part；文本及 JSON 编码正文保持原字节。调用方在工具输出中的显式断点计入共用额度，禁用显式断点时仍保留已支持的会话缓存键。实际命中由供应商 usage 确认。
- 显式缓存断点的型号默认值仅适用于官方 HTTPS 端点。自定义 Base URL 默认保留会话缓存键，显式断点由宿主按该端点实际能力配置 `openaiExplicitCacheBreakpoints`；该配置优先于端点与型号默认值。
- Velar Cloud 托管线路也遵循宿主显式配置的 `openaiExplicitCacheBreakpoints`，不从不透明公共型号推断上游能力；默认不启用，不额外发送会话缓存键。
- 启用 Responses 显式断点时，文本与 JSON 工具结果统一表示为内容块；断点移到后面的结果时，已有正文表示保持稳定。
- `ModelInputEstimate.composition` 给出估算编码文本的 UTF-8 字节分项：系统指令、工具、assistant 历史、user 历史、工具回执、当前材料和包装；各项相加等于 total。图片和不透明推理另外预留容量，费用继续使用供应商真实用量。
- 已知 OpenAI Chat/Responses 型号按公开编码映射延迟加载 `gpt-tokenizer`。同一驱动收到无图请求的真实输入用量后，以 BPE 文本和最近 32 份样本校准后续请求：在已见输入长度范围内，比较覆盖全部样本的线性增长上界与最大固定开销，选择较小值且不低于 BPE 文本计数；范围外或趋势不可用时沿用固定开销，统一保留 10% 余量；主线与借用该驱动的专项会话共用这些数字。冷启动、未知路由或未知型号沿用字节估算；供应商超窗后重置，旧代迟到响应不恢复旧校准。图片请求不参与取样，不透明状态独立预留，估算不充当账单。
