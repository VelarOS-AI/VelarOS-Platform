import type { Context } from 'node:vm'

import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './adapters'

/** 用户上传的 JS adapter 允许返回的 provider 种类，闭集。 */
export type UserAdapterProviderKind = 'openai' | 'anthropic' | 'google'

/** 用户 adapter 建 provider 时能给的设置，只认这三个字符串字段。 */
export interface UserAdapterProviderSettings {
  apiKey?: string
  baseURL?: string
  name?: string
}

/** 沙箱里造出来的 provider：既能直接调，也能走 `.chat(modelId)`。 */
export interface UserAdapterProvider {
  (modelId: string): UserAdapterLanguageModelDescriptor
  chat(modelId: string): UserAdapterLanguageModelDescriptor
}

/** 沙箱唯一允许返回的语言模型形状：三元描述符，真正的 SDK 实例在宿主侧构造。 */
export interface UserAdapterLanguageModelDescriptor {
  __velarosCustomAdapterDescriptor: 'language-model'
  providerKind: UserAdapterProviderKind
  modelId: string
  settings?: UserAdapterProviderSettings
}

/** helpers 里一个 provider 工厂的签名。 */
export type UserAdapterProviderFactory = (
  settings?: UserAdapterProviderSettings
) => UserAdapterProvider

/** 交给用户 adapter 的 helpers：三个 provider 工厂，别的一律不给。 */
export interface UserAdapterHelpers {
  createOpenAI: UserAdapterProviderFactory
  createAnthropic: UserAdapterProviderFactory
  createGoogleGenerativeAI: UserAdapterProviderFactory
}

/** 调用用户 adapter 导出函数时递进去的入参。 */
export interface UserAdapterFactoryInput {
  config: ModelAdapterConfig
  helpers: UserAdapterHelpers
}

/** 用户 adapter 的导出面，跟 provider script 的同名成员形状一致。 */
export interface UserAdapterExports {
  default?: Partial<UserAdapterExports>
  createLanguageModelFactory?: (input: UserAdapterFactoryInput) => LanguageModelFactory
  createEmbeddingRequest?: (
    input: UserAdapterFactoryInput & {
      model: string
      texts: string[]
    }
  ) => EmbeddingRequest
}

/** 允许沙箱脚本调的 console 子集。 */
export type UserAdapterConsole = Pick<typeof console, 'debug' | 'error' | 'info' | 'log' | 'warn'>

/** console 的方法名。 */
export type UserAdapterConsoleMethod = keyof UserAdapterConsole

/** 沙箱 console 落到宿主日志时用的级别。 */
export type UserAdapterConsoleLogLevel = 'debug' | 'error' | 'info' | 'warn'

/** 沙箱里可调的函数；参数类型有意写成 never，逼调用方经搬运层递参数。 */
export type UserAdapterVmCallable = (...args: never[]) => unknown

/** 一次跨边界调用的载荷：函数、至多两个参数与返回值。 */
export interface UserAdapterVmCall {
  fn: UserAdapterVmCallable
  arg0?: unknown
  arg1?: unknown
  result?: unknown
}

/** 沙箱上下文：空原型 global 加上本包放进去的那几样东西。 */
export type UserAdapterVmContext = Context & {
  module: { exports: UserAdapterExports }
  exports: UserAdapterExports
  helpers: UserAdapterHelpers
  console: UserAdapterConsole
  __velarosUserAdapterCall__?: UserAdapterVmCall
  __velarosUserAdapterJson__?: string
  __velarosUserAdapterValue__?: unknown
}

/** 一份已求值的用户 adapter：沙箱上下文、导出面与 helpers。 */
export interface EvaluatedUserAdapter {
  context: UserAdapterVmContext
  exports: UserAdapterExports
  helpers: UserAdapterHelpers
}
