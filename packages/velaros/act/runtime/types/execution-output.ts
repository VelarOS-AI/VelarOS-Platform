import type { ExecutionOutputChunk } from '../../system/types/executions.js'

/** 有界缓存保留绝对偏移，丢弃前文仍能正确报告读取缺口。 */
export interface ExecutionOutputState {
  readonly chunks: readonly ExecutionOutputChunk[]
  readonly totalChars: number
}
