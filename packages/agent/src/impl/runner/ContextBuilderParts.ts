import type { AgentChatRuntimeConfig } from '../../contract/requires.js'
import type { PromptRegistryContract } from '../../types/guidance.js'
import { createBuiltInPromptRegistry } from '../guidance/PromptRegistry'

/**
 * `ContextBuilder` 的零件盒：把「默认段注册表从哪来」「宿主追加的那段提示词怎么归一」两件小事收在一处，
 * 让 ContextBuilder 的构造与装配路径不直接依赖内置目录。无状态，模块级共享一份即可。
 */
export interface ContextBuilderPartsApi {
  /** 建一份内置提示词段注册表；每次调用都是新的一份，调用方可以随意 register/suppress 而不影响别人。 */
  createDefaultRegistry(): PromptRegistryContract
  /** 把宿主配置里的 `systemPromptAppend` 归一成可直接拼接的文本：去掉首尾空白，全空白或缺省一律当作没配，返回 null。 */
  buildPromptAppend(config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>): Nullable<string>
}

class ContextBuilderParts implements ContextBuilderPartsApi {
  public createDefaultRegistry(): PromptRegistryContract {
    return createBuiltInPromptRegistry()
  }

  public buildPromptAppend(config?: Pick<AgentChatRuntimeConfig, 'systemPromptAppend'>): Nullable<string> {
    return config?.systemPromptAppend?.trim() || null
  }
}

export { ContextBuilderParts as ContextBuilderHelper,ContextBuilderParts }
