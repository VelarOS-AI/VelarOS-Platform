import { isBlank, toNullable } from '@velaros-ai/core'

import type { ChatProviderId } from './ModelContracts'

export const OllamaProviderId = 'ollama' satisfies ChatProviderId

export const OllamaEnvNames = {
  baseURL: 'VELAROS_OLLAMA_BASE_URL',
  chatModel: 'VELAROS_OLLAMA_CHAT_MODEL',
  contextWindow: 'VELAROS_OLLAMA_CONTEXT_WINDOW',
} as const

export type ModelEnvironmentVariables = Readonly<Record<string, string | undefined>>

/**
 * Minimal environment port used by the portable catalog.
 *
 * Hosts may implement this interface without exposing their complete process
 * environment to the model package.
 */
export interface ModelEnvironmentPort {
  read(name: string): string | undefined
}

/**
 * Immutable, host-injected model environment.
 *
 * This class deliberately never discovers browser globals or `process.env`.
 * Browser, worker and test hosts can therefore use the same catalog with only
 * the values they explicitly provide.
 */
export class LocalModelEnvironment implements ModelEnvironmentPort {
  private readonly environmentVariables: ModelEnvironmentVariables

  constructor(variables: ModelEnvironmentVariables = {}) {
    this.environmentVariables = Object.freeze({ ...variables })
  }

  public static from(environment: ModelEnvironmentPort): LocalModelEnvironment {
    return environment instanceof LocalModelEnvironment
      ? environment
      : new DelegatingModelEnvironment(environment)
  }

  public read(name: string): string | undefined {
    return this.environmentVariables[name]
  }

  public resolveOllamaBaseURL(defaultBaseURL: string): string {
    const configured =
      this.readString(OllamaEnvNames.baseURL) || this.readString('OLLAMA_HOST')
    const raw = (configured || defaultBaseURL).trim().replace(/\/+$/u, '')
    const baseURL = raw && !/^https?:\/\//iu.test(raw) ? `http://${raw}` : raw
    if (!baseURL) return ''

    return baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`
  }

  public resolveOllamaChatModel(defaultModel = ''): string {
    return this.readString(OllamaEnvNames.chatModel) || defaultModel
  }

  public resolveOllamaContextWindow(defaultContextWindow?: number): Nullable<number> {
    return toNullable(
      this.readPositiveInteger(OllamaEnvNames.contextWindow) ?? defaultContextWindow
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
    const raw = this.readString(name)
    if (!raw) return null

    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return null

    return Math.floor(parsed)
  }
}

const EmptyModelEnvironment: ModelEnvironmentPort = new LocalModelEnvironment()

class DelegatingModelEnvironment extends LocalModelEnvironment {
  constructor(private readonly environment: ModelEnvironmentPort) {
    super()
  }

  public override read(name: string): string | undefined {
    return this.environment.read(name)
  }
}

/**
 * Compatibility helpers retain the 0.4.x functional API while requiring any
 * environment lookup to be injected explicitly.
 */
export function resolveOllamaBaseURL(
  defaultBaseURL: string,
  environment: ModelEnvironmentPort = EmptyModelEnvironment
): string {
  return LocalModelEnvironment.from(environment).resolveOllamaBaseURL(defaultBaseURL)
}

export function resolveOllamaChatModel(
  defaultModel = '',
  environment: ModelEnvironmentPort = EmptyModelEnvironment
): string {
  return LocalModelEnvironment.from(environment).resolveOllamaChatModel(defaultModel)
}

export function resolveOllamaContextWindow(
  defaultContextWindow?: number,
  environment: ModelEnvironmentPort = EmptyModelEnvironment
): Nullable<number> {
  return LocalModelEnvironment.from(environment).resolveOllamaContextWindow(
    defaultContextWindow
  )
}

export function resolveOllamaVisibleChatModels(
  defaultModel = '',
  selectedModel = '',
  environment: ModelEnvironmentPort = EmptyModelEnvironment
): string[] {
  return LocalModelEnvironment.from(environment).resolveOllamaVisibleChatModels(
    defaultModel,
    selectedModel
  )
}
