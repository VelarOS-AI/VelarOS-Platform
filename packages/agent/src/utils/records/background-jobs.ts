import { isFiniteNumber, isPresent, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { KernelBackgroundJob } from '../../types/records.js'
import { compareStableStrings } from '../residency/determinism'

export const DefaultOutputMaxChars = 64 * 1024

export const DefaultTerminalJobTtlMs = 10 * 60 * 1_000

export const DefaultTerminalJobLimit = 200

export const DefaultJobPreviewMaxChars = 2_000

export function cloneJob(job: KernelBackgroundJob): KernelBackgroundJob {
  return { ...job }
}

export function assertNonBlank(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new AppError('VALIDATION', `Kernel background job requires ${label}`, undefined, { label })
  }
  return trimmed
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000))
  return `${seconds}s`
}

/** 收进来什么缺席形态都行，出去只有一种：省略位的 `undefined`（§1.5 边界归一一次）。 */
export function trimOptional(value: LooseOptional<string>): string | undefined {
  const trimmed = value?.trim()
  return toOptional(trimmed)
}

export function normalizeReadOffset(offset: number, length: number): number {
  if (!isFiniteNumber(offset)) return 0
  return Math.max(0, Math.min(Math.floor(offset), length))
}

/** 输出缓冲上限：非有限或非正一律回落缺省（0 会让整条输出链恒空，属坏配置不是合法配置）。 */
export function normalizeOutputMaxChars(maxChars: LooseOptional<number>): number {
  if (!isFiniteNumber(maxChars) || maxChars <= 0) return DefaultOutputMaxChars
  return Math.floor(maxChars)
}

/** 终态任务保留时长：**负值刻意合法**（= 永不按 TTL 清理，见 shouldPruneTerminalJob）。 */
export function normalizeTerminalJobTtlMs(ttlMs: LooseOptional<number>): number {
  if (!isFiniteNumber(ttlMs)) return DefaultTerminalJobTtlMs
  return Math.floor(ttlMs)
}

export function normalizeTerminalJobLimit(limit: LooseOptional<number>): number {
  if (!isFiniteNumber(limit)) return DefaultTerminalJobLimit
  return Math.max(0, Math.floor(limit))
}

export function truncateJobPreview(value: string): string {
  const trimmed = value.trim()
  return trimmed.length <= DefaultJobPreviewMaxChars
    ? trimmed
    : `${trimmed.slice(0, DefaultJobPreviewMaxChars - 1)}…`
}

export function compareTerminalJobs(left: KernelBackgroundJob, right: KernelBackgroundJob): number {
  const completedOrder =
    (left.completedAt ?? left.startedAt) - (right.completedAt ?? right.startedAt)
  if (completedOrder !== 0) return completedOrder
  return compareStableStrings(left.id, right.id)
}

/**
 * wait 超时：**缺席与非有限值语义相反**，不可合并——缺席 = 无限等（等到任务真的收敛），
 * 非有限（NaN/Infinity）= 立即返回快照（0），因为那是调用方传了坏值，无限等会挂死父 Agent。
 */
export function normalizeWaitTimeoutMs(timeoutMs: LooseOptional<number>): LooseOptional<number> {
  if (!isPresent(timeoutMs)) return undefined
  if (!isFiniteNumber(timeoutMs)) return 0
  return Math.max(0, Math.floor(timeoutMs))
}

export function appendArtifactError(output: string, error: LooseOptional<string>): string {
  const normalizedError = error?.trim()
  if (!normalizedError) return output

  const separator = output && !output.endsWith('\n') ? '\n' : ''
  return `${output}${separator}job artifact incomplete: ${normalizedError}`
}
