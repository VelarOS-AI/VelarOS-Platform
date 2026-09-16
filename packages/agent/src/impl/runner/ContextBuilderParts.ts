import type { AgentChatRuntimeConfig } from '../../contract/requires.js'
import type { PromptRegistryApi } from '../../types/guidance.js'
import { createBuiltInPromptRegistry } from '../../utils/guidance/catalog'

class ContextBuilderParts {
  public createDefaultRegistry(): PromptRegistryApi {
    return createBuiltInPromptRegistry()
  }

  public buildPromptAppend(config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>): Nullable<string> {
    return config?.systemPromptAppend?.trim() || null
  }
}

export { ContextBuilderParts as ContextBuilderHelper,ContextBuilderParts }
