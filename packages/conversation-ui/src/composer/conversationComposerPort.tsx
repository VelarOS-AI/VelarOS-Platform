import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

import type { AppLocale, MicrophonePermissionStatus } from '#contracts'
import { Result } from '#internal/result'

/**
 * `ConversationComposerPort` — 会话输入框（composer 第五原子，pass-5 収口）的**宿主能力注入端口**。
 *
 * 镜像 pass-4 `ConversationActionPort` 先例：数据 + 会话层回调经 `ChatComposerControl` 投影穿过（那是主
 * 注入面），本端口只承载**深埋在组件树内、无法自然经 props 线程化的环境能力**——本地语音转写 / 麦克风权限
 * 三件 IPC、云特性开关（experimental）、以及 composer 作用域的轻量提示（草稿超限 / 语音错误 toast）。
 *
 * 契约类型收窄自成，不直依宿主 `rendererIpc`/云账户上下文；desktop 在装配点绑定其现有实现（`rendererIpc.settings.*`
 * / `useCloudFeatureAccess().experimentalFeatures` / `globalMessage.*`）。宪章§14「通用聊天框注入面」：任何宿主
 * 提供这一端口 + `ChatComposerControl` 即可复用整套 composer。
 */

/** 本地语音转写请求（音频 base64 + 语言），镜像宿主 `settings.transcribeLocalSpeech` 入参。 */
export interface ComposerLocalSpeechRequest {
  audioBase64: string
  locale: AppLocale
}

/** 本地语音转写结果（转写文本）。 */
export interface ComposerLocalSpeechTranscription {
  text: string
}

/** composer 作用域提示：草稿超限 warning、语音错误 error（error 支持带动作按钮，如「打开麦克风设置」）。 */
export interface ConversationComposerNotify {
  warning: (options: { title: string; description?: string }) => void
  error: (options: {
    title: string
    description?: string
    duration?: number
    actionLabel?: string
    onAction?: () => void
  }) => void
}

export interface ConversationComposerPort {
  /** 本地语音（whisper 插件）转写；宿主绑 `rendererIpc.settings.transcribeLocalSpeech`。 */
  transcribeLocalSpeech: (
    request: ComposerLocalSpeechRequest
  ) => Promise<Result<ComposerLocalSpeechTranscription>>
  /** 请求麦克风权限；宿主绑 `rendererIpc.settings.requestMicrophonePermission`。 */
  requestMicrophonePermission: () => Promise<Result<MicrophonePermissionStatus>>
  /** 打开系统麦克风设置（fire-and-forget，宿主实现内部自带失败 toast）。 */
  openMicrophoneSettings: () => Promise<void>
  /** 云特性开关（实验性能力）；宿主绑 `useCloudFeatureAccess().experimentalFeatures`。kernel 零商业逻辑。 */
  experimentalFeaturesEnabled: boolean
  /** composer 作用域提示；宿主绑全局消息条 `globalMessage.warning/error`。 */
  notify: ConversationComposerNotify
}

/**
 * 无操作端口——组件图鉴/预览等无宿主能力上下文（无 CloudAccountProvider / GlobalMessage）时占位，
 * 避免 `useConversationComposerPort` 抛错。语音/提示皆为惰性空实现。
 */
export const emptyConversationComposerPort: ConversationComposerPort = {
  transcribeLocalSpeech: () => Promise.resolve(Result.ok({ text: '' })),
  requestMicrophonePermission: () => Promise.resolve(Result.ok('denied')),
  openMicrophoneSettings: () => Promise.resolve(),
  experimentalFeaturesEnabled: false,
  notify: {
    warning: () => undefined,
    error: () => undefined,
  },
}

const ConversationComposerPortContext = createContext<Nullable<ConversationComposerPort>>(null)

export function ConversationComposerPortProvider({
  children,
  value,
}: {
  children: ReactNode
  value: ConversationComposerPort
}): ReactElement {
  return (
    <ConversationComposerPortContext.Provider value={value}>
      {children}
    </ConversationComposerPortContext.Provider>
  )
}

export function useConversationComposerPort(): ConversationComposerPort {
  const context = useContext(ConversationComposerPortContext)
  if (!context) {
    throw new Error(
      'useConversationComposerPort must be used within ConversationComposerPortProvider'
    )
  }
  return context
}
