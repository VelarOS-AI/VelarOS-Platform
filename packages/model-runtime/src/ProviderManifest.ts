import type { ChatProviderId, ProviderScriptManifest } from './ModelContracts'

export const OpenAICompatibleGatewayDefaultBaseURL = 'http://localhost:3001/v1'

export const OpenRouterCompatibleProviderIds = [
  'openrouter',
] as const satisfies readonly ChatProviderId[]

export const DirectOpenAICompatibleProviderIds = [
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
  'freellmapi',
] as const satisfies readonly ChatProviderId[]

export type ModelProviderAdapterKind =
  | 'openai-sdk'
  | 'openai-compatible'
  | 'anthropic-sdk'
  | 'google-sdk'
  | 'deepseek-sdk'
  | 'provider-script'
  | 'custom-js'

export type ModelProviderValidationKind =
  | 'velar-managed'
  | 'openrouter-key'
  | 'openai-compatible-models'
  | 'anthropic-models'
  | 'google-models'
  | 'provider-script'
  | 'custom-adapter-source'

export interface ModelProviderOperationalManifest {
  id: ChatProviderId
  label: string
  defaultBaseURL: string
  description: string
  adapterKind: ModelProviderAdapterKind
  validationKind: ModelProviderValidationKind
  defaultApiKeyEnv?: string
  defaultApiKey?: string
  apiKeyOptional?: boolean
  compatibilityNote?: string
  enabledByDefault?: boolean
  debugOnly?: boolean
  baseURLConfigurable?: boolean
  managedByCloud?: boolean
  providerScript?: ProviderScriptManifest
}

const BaseModelProviderOperationalManifests = [
  {
    id: 'velar',
    label: 'Velar',
    defaultBaseURL: '',
    description: '由 VelarOS Cloud 按工作类型自动选择和编排模型，无需配置密钥或模型。',
    defaultApiKey: 'velar-managed',
    apiKeyOptional: true,
    enabledByDefault: true,
    managedByCloud: true,
    adapterKind: 'openai-compatible',
    validationKind: 'velar-managed',
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
    compatibilityNote:
      'Claude 官方 API 当前不提供 OpenAI 风格 embedding；记忆和知识库向量不可用时会回退文本检索。',
  },
  {
    id: 'google',
    label: 'Gemini',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    description: '直连 Google Gemini API，支持 Gemini Pro / Flash 系列模型。',
    defaultApiKeyEnv: 'GEMINI_API_KEY',
    adapterKind: 'google-sdk',
    validationKind: 'google-models',
    compatibilityNote:
      'Gemini embedding 与 OpenAI 响应格式不同；记忆和知识库向量不可用时会回退文本检索。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com',
    description: '直连 DeepSeek 官方 API，使用 OpenAI 兼容聊天接口。',
    defaultApiKeyEnv: 'DEEPSEEK_API_KEY',
    adapterKind: 'deepseek-sdk',
    validationKind: 'openai-compatible-models',
    compatibilityNote:
      'DeepSeek 官方 API 当前不提供 embedding；记忆和知识库向量不可用时会回退文本检索。',
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
    id: 'freellmapi',
    label: 'OpenAI-compatible Gateway',
    defaultBaseURL: OpenAICompatibleGatewayDefaultBaseURL,
    description: '连接任意 OpenAI-compatible 聚合网关或本地服务，默认示例地址兼容本机 FreeLLMAPI。',
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
] as const satisfies readonly ModelProviderOperationalManifest[]

export const ModelProviderOperationalManifests: readonly ModelProviderOperationalManifest[] = [
  ...BaseModelProviderOperationalManifests,
]

const ModelProviderOperationalManifestMap = new Map(
  ModelProviderOperationalManifests.map((manifest) => [manifest.id, manifest])
)

export function getModelProviderOperationalManifest(
  providerId: ChatProviderId
): Nullable<ModelProviderOperationalManifest> {
  return ModelProviderOperationalManifestMap.get(providerId) ?? null
}

export function getModelProviderIdsByAdapterKind(
  adapterKind: ModelProviderAdapterKind
): ChatProviderId[] {
  return ModelProviderOperationalManifests.filter(
    (manifest) => manifest.adapterKind === adapterKind
  ).map((manifest) => manifest.id)
}
