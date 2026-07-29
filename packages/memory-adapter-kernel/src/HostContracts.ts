import type {
  MemoryEvidenceInput,
  MemoryScopeId,
} from '@velaros-ai/memory'

export interface MemoryHostScopeInput {
  sessionId: string
  workspaceRoot?: LooseOptional<string>
  /** Opaque host context identity; Memory never interprets product workspace enums. */
  contextId?: LooseOptional<string>
}

export type MemoryHostScope = Pick<
  MemoryEvidenceInput,
  'scopeType' | 'scopeId'
> & {
  scopeId: MemoryScopeId
}

export type MemoryHostScopeResolver = (
  input: MemoryHostScopeInput
) => MemoryHostScope

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
