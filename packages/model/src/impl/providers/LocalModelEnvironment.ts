import { isBlank, toNullable } from '@velaros-ai/core'

import { OllamaHostEnvironmentName } from '../../contract/constants.js'
import type { ModelEnvironmentPort } from '../../contract/requires'
import { toPositiveInteger } from '../../utils/numbers'
import { trimTrailingPathSeparators } from '../../utils/urls'

/**
 * 宿主注入的模型环境快照。
 *
 * 这个类刻意不去发现浏览器全局或 `process.env`：渲染进程、worker 与测试宿主都用同一份目录逻辑，
 * 只把自己愿意给的值传进来。要按需读值而不是给一份快照时，构造第二个参数传一个端口。
 */
export interface LocalModelEnvironmentApi {
  /** 读一个环境变量；没有就返回 undefined。 */
  read(name: string): string | undefined
  /** 本机 Ollama 的服务地址：先看本仓的变量，再看 Ollama 自己的 `OLLAMA_HOST`，最后用缺省值；返回值一定带 `/v1`。 */
  resolveOllamaBaseURL(defaultBaseURL: string): string
  /** 本机 Ollama 的聊天模型名；环境变量没给就用调用方的缺省值。 */
  resolveOllamaChatModel(defaultModel?: string): string
  /** 本机 Ollama 的上下文窗口；环境变量与缺省值都没有时返回 null。 */
  resolveOllamaContextWindow(defaultContextWindow?: number): Nullable<number>
  /** 本机 Ollama 在界面上可见的模型：环境变量里的那个加上当前选中的那个，去重。 */
  resolveOllamaVisibleChatModels(defaultModel?: string, selectedModel?: string): string[]
}

export class LocalModelEnvironment implements LocalModelEnvironmentApi {
  /** 本类读的三个环境变量名；权威登记在 `contract/constants.ts` 的 `ModelEnvironmentVariables`。 */
  private static readonly OllamaEnvironmentNames = {
    baseURL: 'VELAROS_OLLAMA_BASE_URL',
    chatModel: 'VELAROS_OLLAMA_CHAT_MODEL',
    contextWindow: 'VELAROS_OLLAMA_CONTEXT_WINDOW',
  } as const

  private readonly environmentVariables: Readonly<Record<string, string | undefined>>

  constructor(
    variables: Readonly<Record<string, string | undefined>> = {},
    private readonly environmentPort?: ModelEnvironmentPort
  ) {
    this.environmentVariables = Object.freeze({ ...variables })
  }

  public read(name: string): string | undefined {
    return this.environmentPort ? this.environmentPort.read(name) : this.environmentVariables[name]
  }

  public resolveOllamaBaseURL(defaultBaseURL: string): string {
    const configured =
      this.readString(LocalModelEnvironment.OllamaEnvironmentNames.baseURL) || this.readString(OllamaHostEnvironmentName)
    const raw = trimTrailingPathSeparators(configured || defaultBaseURL)
    const baseURL = raw && !/^https?:\/\//iu.test(raw) ? `http://${raw}` : raw
    if (!baseURL) return ''

    return baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`
  }

  public resolveOllamaChatModel(defaultModel = ''): string {
    return this.readString(LocalModelEnvironment.OllamaEnvironmentNames.chatModel) || defaultModel
  }

  public resolveOllamaContextWindow(defaultContextWindow?: number): Nullable<number> {
    return toNullable(
      this.readPositiveInteger(LocalModelEnvironment.OllamaEnvironmentNames.contextWindow) ?? defaultContextWindow
    )
  }

  public resolveOllamaVisibleChatModels(defaultModel = '', selectedModel = ''): string[] {
    const models = [
      this.resolveOllamaChatModel(defaultModel),
      selectedModel.trim(),
    ].filter((model) => !isBlank(model))

    return [...new Set(models)]
  }

  private readString(name: string): string {
    return (this.read(name) ?? '').trim()
  }

  private readPositiveInteger(name: string): Nullable<number> {
    return toPositiveInteger(this.readString(name))
  }
}
