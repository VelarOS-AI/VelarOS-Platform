import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

import type { ActiveContextArtifact, ChatGoalLifecycleAction } from '#contracts'

/**
 * 会话壳的**动作注入端口**（pass-4 收口）——把 `ChatConversationPane` 的目标生命周期 IPC 站点
 * （getGoalLifecycle / updateGoalLifecycle / provideExecutionGuidance）以领域动作形式注入进包。
 * IPC `Result` 拆封与 rendererIpc 绑定全留宿主实现（`desktopConversationActionPort`）；包侧只吃领域值。
 */
/**
 * 目标生命周期读取/更新结果：`ok:false` = 软失败（保留当前状态，不覆盖）；IPC 异常由实现抛出，调用方
 * try/catch 兜底刷新。宿主实现只把 rendererIpc 的 `Result` 拆成此判别值（`ok` + 领域 goal）。
 */
export interface ConversationGoalLifecycleResult {
  ok: boolean
  goal: Nullable<ActiveContextArtifact>
}

export interface ConversationActionPort {
  getGoalLifecycle: (sessionId: string) => Promise<ConversationGoalLifecycleResult>
  updateGoalLifecycle: (
    sessionId: string,
    action: ChatGoalLifecycleAction
  ) => Promise<ConversationGoalLifecycleResult>
  /** 运行中向执行下发继续引导（宿主构造 SerializedMessage 并投递）。 */
  provideExecutionGuidance: (sessionId: string, guidance: string) => Promise<void>
}

const ConversationActionPortContext = createContext<Nullable<ConversationActionPort>>(null)

export function ConversationActionPortProvider({
  value,
  children,
}: {
  value: ConversationActionPort
  children: ReactNode
}): ReactElement {
  return (
    <ConversationActionPortContext.Provider value={value}>
      {children}
    </ConversationActionPortContext.Provider>
  )
}

export function useConversationActionPort(): ConversationActionPort {
  const value = useContext(ConversationActionPortContext)
  if (!value) {
    throw new Error(
      'useConversationActionPort must be used within ConversationActionPortProvider (host 装配点注入)。'
    )
  }
  return value
}
