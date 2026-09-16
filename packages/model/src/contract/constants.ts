/**
 * model 域对外约定的常量表。
 *
 * 这个文件不 import 任何东西：内核身份、provider 清单、错误码、环境变量名与 wire 上限都是
 * 跨进程、跨产品共享的约定，任何宿主（含渲染进程与外部脚本）都要能只读这一个文件就把它们拿全。
 */

/** 内核能力身份：宿主按它取模型适配器注册表。 */
export const ModelCapabilityId = 'velaros.model' as const

/** 模型内核模块身份：装配内核时按它去重与排序。 */
export const ModelKernelModuleId = 'velaros.model.registry' as const

/** 模型内核模块版本：改了 wire 面才动它。 */
export const ModelKernelModuleVersion = '0.3.0' as const

/** wire 面的入参上限；越界一律拒，不截断。 */
export const ModelWireLimits = Object.freeze({
  /** provider id 是标识符不是载荷，最多这么多个字符。 */
  providerIdChars: 128,
})

/** 适配器种类：一个 provider 用哪一套 SDK/协议接入。 */
export const ModelProviderAdapterKinds = Object.freeze([
  'openai-sdk',
  'openai-compatible',
  'anthropic-sdk',
  'google-sdk',
  'deepseek-sdk',
  'provider-script',
  'custom-js',
] as const)

/** 连通性校验方式：设置页验证一个 provider 时走哪条路径。 */
export const ModelProviderValidationKinds = Object.freeze([
  'velar-managed',
  'openrouter-key',
  'openai-compatible-models',
  'anthropic-models',
  'google-models',
  'provider-script',
  'custom-adapter-source',
] as const)

/** 思考深度三档：产品的旧口径，仍然是 provider 参数映射的兜底轴。 */
export const ThinkingDepths = Object.freeze(['fast', 'balanced', 'deep'] as const)

/** 思考力度五档：存在时优先于 thinkingDepth 决定 reasoning 的开关、力度与预算。 */
export const ReasoningLevels = Object.freeze([
  'off',
  'low',
  'medium',
  'high',
  'ultra',
] as const)

/** 具体模型接受的输入形态；缺席表示未知，不表示不支持。 */
export const ModelInputModalities = Object.freeze(['text', 'image', 'audio'] as const)

/** OpenAI 兼容网关的缺省地址：本机自建网关的习惯端口。 */
export const OpenAICompatibleGatewayDefaultBaseURL = 'http://localhost:3001/v1' as const

/** 本机 Ollama 的 provider id；上下文窗口等本地约定按它分支。 */
export const OllamaProviderId = 'ollama' as const

/** OpenRouter 的自动路由模型 id。 */
export const OpenRouterAutoModelId = 'openrouter/auto' as const

/** OpenRouter 的免费模型 id（调试用）。 */
export const OpenRouterFreeModelId = 'openrouter/free' as const

/** Velar Cloud 的自动路由模型 id。 */
export const VelarAutoModelId = 'velar/auto' as const

/** 走 OpenRouter 路由语义的 provider；注入 reasoning 与 auto-router 插件时按它判。 */
export const OpenRouterCompatibleProviderIds = Object.freeze(['openrouter'] as const)

/** 直连 OpenAI 兼容接口的 provider；它们共用同一套 chat/completions 与 embeddings 形状。 */
export const DirectOpenAICompatibleProviderIds = Object.freeze([
  'xai',
  'qwen',
  'moonshot',
  'zhipu',
  'mistral',
  'minimax',
  'groq',
  'volcengine',
  'ollama',
  'lmstudio',
  'openai-compatible-gateway',
] as const)

/** 允许用户直接输入模型名的 provider：它们的目录只是建议，不是白名单。 */
export const CustomModelProviderIds = Object.freeze([
  'velar',
  'velar-dev',
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'deepseek',
  ...DirectOpenAICompatibleProviderIds,
  'custom',
] as const)

/** 由 VelarOS Cloud 托管的 provider：凭据在宿主的登录态里，本包只拿绑定。 */
export const VelarCloudManagedProviderIds = Object.freeze(['velar', 'velar-dev'] as const)

/** 内置 provider 的运营清单：产品设置页、连通性校验与适配器装配都按它走。 */
export const ModelProviderOperationalManifests = Object.freeze([
  {
    id: 'velar',
    label: 'VelarOS',
    defaultBaseURL: '',
    description: '由 VelarOS Cloud 提供 OpenRouter 精选模型与费用目录，无需配置密钥。',
    defaultApiKey: 'velar-managed',
    apiKeyOptional: true,
    enabledByDefault: true,
    managedByCloud: true,
    adapterKind: 'openai-compatible',
    validationKind: 'velar-managed',
  },
  {
    id: 'velar-dev',
    label: 'Velar Dev',
    defaultBaseURL: '',
    description: '由 VelarOS Cloud 为授权账户提供的内部模型目录，无需配置密钥。',
    defaultApiKey: 'velar-dev-managed',
    apiKeyOptional: true,
    enabledByDefault: true,
    managedByCloud: true,
    adapterKind: 'openai-compatible',
    validationKind: 'velar-managed',
    compatibilityNote: 'Velar Dev 当前只提供聊天模型；embedding 继续使用宿主单独选择的向量服务。',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    description: '统一接入海外与国内主流文本模型，只保留文本向聊天与推理模型。',
    defaultApiKeyEnv: 'OPENROUTER_API_KEY',
    adapterKind: 'openai-sdk',
    validationKind: 'openrouter-key',
  },
  {
    id: 'openai',
    label: 'ChatGPT',
    defaultBaseURL: 'https://api.openai.com/v1',
    description: '直连 OpenAI，用于 ChatGPT / GPT 调试与直接调用。',
    defaultApiKeyEnv: 'OPENAI_API_KEY',
    adapterKind: 'openai-sdk',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'anthropic',
    label: 'Claude',
    defaultBaseURL: 'https://api.anthropic.com/v1',
    description: '直连 Anthropic Claude 官方 API，使用 Messages 接口。',
    defaultApiKeyEnv: 'ANTHROPIC_API_KEY',
    adapterKind: 'anthropic-sdk',
    validationKind: 'anthropic-models',
    compatibilityNote: 'Claude 官方 API 当前不提供 OpenAI 风格 embedding。',
  },
  {
    id: 'google',
    label: 'Gemini',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    description: '直连 Google Gemini API，支持 Gemini Pro / Flash 系列模型。',
    defaultApiKeyEnv: 'GEMINI_API_KEY',
    adapterKind: 'google-sdk',
    validationKind: 'google-models',
    compatibilityNote: 'Gemini embedding 与 OpenAI 响应格式不同，本包不接入。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com',
    description: '直连 DeepSeek 官方 API，使用 OpenAI 兼容聊天接口。',
    defaultApiKeyEnv: 'DEEPSEEK_API_KEY',
    adapterKind: 'deepseek-sdk',
    validationKind: 'openai-compatible-models',
    compatibilityNote: 'DeepSeek 官方 API 当前不提供 embedding。',
  },
  {
    id: 'xai',
    label: 'xAI',
    defaultBaseURL: 'https://api.x.ai/v1',
    description: '直连 xAI 官方 OpenAI-compatible API，使用 Grok 系列模型。',
    defaultApiKeyEnv: 'XAI_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    description: '直连阿里云百炼 / DashScope OpenAI 兼容接口，使用 Qwen 系列模型。',
    defaultApiKeyEnv: 'DASHSCOPE_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'moonshot',
    label: 'Kimi',
    defaultBaseURL: 'https://api.moonshot.ai/v1',
    description: '直连 Moonshot / Kimi OpenAI 兼容接口。',
    defaultApiKeyEnv: 'MOONSHOT_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'zhipu',
    label: 'GLM',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    description: '直连智谱 BigModel OpenAI 兼容接口，使用 GLM 系列模型。',
    defaultApiKeyEnv: 'ZHIPUAI_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    defaultBaseURL: 'https://api.mistral.ai/v1',
    description: '直连 Mistral La Plateforme API。',
    defaultApiKeyEnv: 'MISTRAL_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    defaultBaseURL: 'https://api.minimax.io/v1',
    description: '直连 MiniMax OpenAI-compatible API，使用 M 系列模型。',
    defaultApiKeyEnv: 'MINIMAX_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'groq',
    label: 'Groq',
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    description: '直连 Groq OpenAI-compatible API，适合低延迟开源模型推理。',
    defaultApiKeyEnv: 'GROQ_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'volcengine',
    label: 'Doubao',
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    description: '直连火山方舟 OpenAI-compatible API，使用豆包系列模型或方舟 endpoint。',
    defaultApiKeyEnv: 'ARK_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    defaultBaseURL: 'http://localhost:11434/v1',
    description: '连接本机 Ollama OpenAI-compatible 服务。',
    defaultApiKey: 'ollama',
    apiKeyOptional: true,
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    defaultBaseURL: 'http://localhost:1234/v1',
    description: '连接本机 LM Studio OpenAI-compatible 服务。',
    defaultApiKey: 'lmstudio',
    apiKeyOptional: true,
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
  },
  {
    id: 'openai-compatible-gateway',
    label: 'OpenAI-compatible Gateway',
    defaultBaseURL: OpenAICompatibleGatewayDefaultBaseURL,
    description: '连接任意 OpenAI-compatible 聚合网关或本地服务。',
    defaultApiKeyEnv: 'OPENAI_COMPATIBLE_GATEWAY_API_KEY',
    adapterKind: 'openai-compatible',
    validationKind: 'openai-compatible-models',
    baseURLConfigurable: true,
  },
  {
    id: 'custom',
    label: 'Custom Adapter',
    defaultBaseURL: '',
    description: '上传自定义 JS adapter 接入未内置的模型供应商，模型可直接输入。',
    apiKeyOptional: true,
    adapterKind: 'custom-js',
    validationKind: 'custom-adapter-source',
    baseURLConfigurable: true,
  },
] as const)

/**
 * 每个内置 provider 的缺省模型。
 *
 * 直接写成字面量而不是由静态目录算出来：这是对外承诺的约定，产品照着它建首次配置。
 * 与静态目录的一致性由 `test/default-provider-models.test.ts` 逐条核对。
 */
export const DefaultProviderModels = Object.freeze({
  openrouter: OpenRouterAutoModelId,
  openai: 'gpt-5.5',
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-3.1-pro-preview',
  deepseek: 'deepseek-v4-flash',
  xai: 'grok-4.20',
  qwen: 'qwen3.6-plus',
  moonshot: 'kimi-k2.6',
  zhipu: 'glm-5.1',
  mistral: 'mistral-medium-3.1',
  minimax: 'MiniMax-M2.7',
  groq: 'llama-3.3-70b-versatile',
  volcengine: 'doubao-seed-1-6',
  ollama: 'gpt-oss:20b',
  lmstudio: 'openai/gpt-oss-20b',
  'openai-compatible-gateway': '',
  custom: '',
  velar: VelarAutoModelId,
  'velar-dev': '',
})

/**
 * model 域的失败码：外面按码分支，不按文字分支。
 *
 * 通用码（VALIDATION、NETWORK、TIMEOUT、UNAVAILABLE）沿用 core，这里只登记本域特有的判据。
 */
export const ModelErrorCodes = Object.freeze({
  /** provider 不在内置清单里，也没有对应的 provider script。 */
  providerUnknown: 'MODEL_PROVIDER_UNKNOWN',
  /** provider 认得，但当前运行时配置下不可用（未启用、缺配置、没有适配器）。 */
  providerUnavailable: 'MODEL_PROVIDER_UNAVAILABLE',
  /** provider 需要凭据而当前没有：UI 配置与环境变量都没给。 */
  credentialMissing: 'MODEL_CREDENTIAL_MISSING',
  /** 没有任何适配器认领这个 provider。 */
  adapterMissing: 'MODEL_ADAPTER_MISSING',
  /** provider script 缺失、导出形状不对，或 manifest 不合法。 */
  providerScriptInvalid: 'MODEL_PROVIDER_SCRIPT_INVALID',
  /** 用户上传的自定义 JS adapter 没有按契约导出，或返回值形状不对。 */
  customAdapterInvalid: 'MODEL_CUSTOM_ADAPTER_INVALID',
  /** Velar Cloud 托管 provider 尚未连接：宿主还没注册账户绑定。 */
  cloudNotConnected: 'MODEL_CLOUD_NOT_CONNECTED',
  /** 这个 provider 没有接入 embedding。 */
  embeddingUnsupported: 'MODEL_EMBEDDING_UNSUPPORTED',
})

/**
 * 本包读的环境变量登记表。
 *
 * 各厂商的 API Key 变量名不在这里重复登记：它们是 `ModelProviderOperationalManifests`
 * 里每条清单的 `defaultApiKeyEnv`，那一份就是权威。
 */
export const ModelEnvironmentVariables = Object.freeze({
  ollamaBaseURL: Object.freeze({
    name: 'VELAROS_OLLAMA_BASE_URL',
    description: '本机 Ollama 的服务地址；缺席时回落到 OLLAMA_HOST，再回落到清单里的缺省地址。',
  }),
  ollamaChatModel: Object.freeze({
    name: 'VELAROS_OLLAMA_CHAT_MODEL',
    description: '本机 Ollama 的聊天模型名；缺席时用调用方给的缺省模型。',
  }),
  ollamaContextWindow: Object.freeze({
    name: 'VELAROS_OLLAMA_CONTEXT_WINDOW',
    description: '本机 Ollama 的上下文窗口；正整数，出线时写进请求体的 options.num_ctx。',
  }),
})

/** Ollama 三个环境变量名的简写，按用途取用。 */
export const OllamaEnvNames = Object.freeze({
  baseURL: ModelEnvironmentVariables.ollamaBaseURL.name,
  chatModel: ModelEnvironmentVariables.ollamaChatModel.name,
  contextWindow: ModelEnvironmentVariables.ollamaContextWindow.name,
})

/**
 * Ollama 官方自己定义的服务地址变量。
 *
 * 名字由 Ollama 定，本仓改不了，所以它不进 `ModelEnvironmentVariables`（那张表只登记 VELAROS_ 前缀）。
 */
export const OllamaHostEnvironmentName = 'OLLAMA_HOST' as const
