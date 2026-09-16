/** 宿主事件与作用域解析的数据形状。 */

import type { MemoryHostScopeResolver, MemoryStoreBackend } from '../contract/requires'

import type { MemoryEvidenceInput, MemoryScopeId } from './memory'

/** 宿主给记忆的上下文读数：由它解析出这次读写落在哪个作用域。 */
export interface MemoryHostScopeInput {
  /** 当前会话 id。 */
  sessionId: string
  /** 当前工作区根；没有项目时缺席。 */
  workspaceRoot?: LooseOptional<string>
  /** 宿主自己的上下文身份，对记忆是不透明的；记忆从不解释产品的空间枚举。 */
  contextId?: LooseOptional<string>
}

/** 宿主解析出来的作用域：种类与 id 两格。 */
export type MemoryHostScope = Pick<
  MemoryEvidenceInput,
  'scopeType' | 'scopeId'
> & {
  scopeId: MemoryScopeId
}

export interface MemoryHostUserMessage {
  role: 'user' | 'assistant'
  textBlocks: string[]
  messageId?: LooseOptional<string>
  timestamp?: number
}

export interface MemoryHostUserMessageEvent extends MemoryHostScopeInput {
  messages: MemoryHostUserMessage[]
  agentSurfaceId?: LooseOptional<string>
}

export interface MemoryHostTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  textBlocks: string[]
  timestamp: number
}

export interface MemoryHostSessionSnapshot extends MemoryHostScopeInput {
  title?: LooseOptional<string>
  messages: MemoryHostTranscriptMessage[]
}

/** 一次桌面操作观察：宿主把工具调用的身份与入参交给采集桥。 */
export interface MemoryComputerUseObservationInput {
  /** 当前会话 id。 */
  sessionId: string
  /** 这次工具调用的 id，用作证据去重的来源 id。 */
  toolCallId: string
  /** 工具名。 */
  toolName: string
  /** 工具入参；采集桥只读其中少数几个字段拼描述，不整份保存。 */
  args: Record<string, unknown>
  /** 当前工作区根。 */
  workspaceRoot?: LooseOptional<string>
  /** 事件发生时间戳，毫秒。 */
  occurredAt?: number
  /** 当前任务标题。 */
  taskTitle?: LooseOptional<string>
  /** 宿主上下文身份。 */
  contextId?: LooseOptional<string>
}

/** 一次工作区工具观察：在桌面观察之上多一个类别与必填的任务标题。 */
export interface MemoryWorkspaceToolObservationInput extends MemoryComputerUseObservationInput {
  /** 这次调用属于宿主的哪个工具类别。 */
  categoryId: 'project-files' | 'project-changes' | 'project-execution' | 'development-code'
  /** 当前任务标题（工作区观察必填）。 */
  taskTitle: string
}

/** 一次执行生命周期观察：宿主把执行阶段交给采集桥。 */
export interface MemoryExecutionObservationInput {
  /** 当前会话 id。 */
  sessionId: string
  /** 这次事件的 id，用作证据去重的来源 id。 */
  sourceEventId: string
  /** 执行阶段名。 */
  kind: string
  /** 当前任务标题。 */
  taskTitle: string
  /** 当前工作区根。 */
  workspaceRoot?: LooseOptional<string>
  /** 这次执行的 id。 */
  executionId?: LooseOptional<string>
  /** 事件发生时间戳，毫秒。 */
  occurredAt?: number
  /** 宿主上下文身份。 */
  contextId?: LooseOptional<string>
}

/** 桌面操作观察的历史名字。 */
export type ComputerUseObservationInput = MemoryComputerUseObservationInput

/** 工作区工具观察的历史名字。 */
export type WorkspaceToolObservationInput = MemoryWorkspaceToolObservationInput

/** 执行生命周期观察的历史名字。 */
export type ExecutionObservationInput = MemoryExecutionObservationInput

/** 回合召回协调器要什么。 */
export interface MemoryTurnRecallDeps {
  /**
   * 召回动词。由 capability token 解析出的后端提供——本协调器不认识后端是树、文件还是
   * 并联了向量索引，只认窄端口的 `recall`。
   */
  recall: MemoryStoreBackend['recall']
  /** 自动记忆总开关；关闭后不采集也不注入召回。 */
  isEnabled?: () => boolean
  /** 单条会话的召回豁免；缺席 = 不豁免。 */
  isSessionRecallAllowed?: (sessionId: string) => boolean
  /** 普通召回无果时是否自动降级深层召回。 */
  isAutomaticDeepRecallEnabled?: () => boolean
  /** 上下文 → 作用域的解析器。 */
  resolveScope: MemoryHostScopeResolver
  /** 回合上下文注入允许出现在哪些空间。 */
  turnContextScopes: readonly string[]
}

