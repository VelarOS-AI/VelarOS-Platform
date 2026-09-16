import { isFiniteNumber, isPresent, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { KernelBackgroundJob } from '../../types/records.js'
import { compareStableStrings } from '../residency/determinism'

export const DefaultOutputMaxChars = 64 * 1024

export const DefaultTerminalJobTtlMs = 10 * 60 * 1_000

export const DefaultTerminalJobLimit = 200

export const DefaultJobPreviewMaxChars = 2_000

/**
 * 浅拷贝一条任务记录。manager 对外交出的每条 job 都要过它：内部这份对象会被持续改写
 * （`status`、`completedAt`、`result`…），把它原样递出去，调用方手上那份会在下一次状态流转时背后变样，
 * 于是「我刚读到 running」和「我现在拿的这个对象」对不上。
 */
export function cloneJob(job: KernelBackgroundJob): KernelBackgroundJob {
  return { ...job }
}

/** 后台任务必填字段的校验：去首尾空白后必须非空，否则抛 `AppError('VALIDATION')`，并把 `label` 一并放进错误详情以便上层指出是哪个字段；返回去过空白的值。 */
export function assertNonBlank(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new AppError('VALIDATION', `后台任务缺少 ${label}：这个字段去掉首尾空白后必须仍有内容。`, undefined, { label })
  }
  return trimmed
}

/** 把毫秒格成给人看的秒数（`"12s"`）：四舍五入，且**至少 1 秒**。给「已 N 无可见输出」这类停滞文案用，兜到 1 是因为写出「已 0s 无输出」会和这句提示本身自相矛盾。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000))
  return `${seconds}s`
}

/** 收进来什么缺席形态都行，出去只有一种：省略位的 `undefined`（§1.5 边界归一一次）。 */
export function trimOptional(value: LooseOptional<string>): string | undefined {
  const trimmed = value?.trim()
  return toOptional(trimmed)
}

/**
 * 把调用方给的读取偏移夹进 `[0, length]`：非有限值（NaN/Infinity）当 0，小数向下取整，超出长度就贴到末尾。
 * 偏移会直接喂给 `output.slice(offset)`——负数在那里表示「从尾部倒数」，会把一段早已读过的尾巴重新吐出来；
 * 夹住之后最坏也只是返回空片段。
 */
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

/** 终态任务保留条数：非有限值回落缺省，其余向下取整并夹到 ≥0。这里 **0 是合法配置**（任务一到终态就清掉），与 `normalizeOutputMaxChars` 把 0 当坏配置相反——那边 0 会让整条输出链恒空，这边 0 只是不留历史。 */
export function normalizeTerminalJobLimit(limit: LooseOptional<number>): number {
  if (!isFiniteNumber(limit)) return DefaultTerminalJobLimit
  return Math.max(0, Math.floor(limit))
}

/**
 * 把任务的结果/错误压成预览：去空白，超过 `DefaultJobPreviewMaxChars` 就切到差一位再补一个 `…`（显式标出被截过）。
 * 截掉的部分不在 job 记录里留存，要全文得走 `job:read_output` 去输出存储读——预览是控制面字段，
 * 会跟着任务列表一次次进上下文，不设上限的话一条大输出会被反复带进每一轮。
 */
export function truncateJobPreview(value: string): string {
  const trimmed = value.trim()
  return trimmed.length <= DefaultJobPreviewMaxChars
    ? trimmed
    : `${trimmed.slice(0, DefaultJobPreviewMaxChars - 1)}…`
}

/**
 * 终态任务的排序判据：按完成时刻**升序**（没有 `completedAt` 的用 `startedAt` 兜底），同一毫秒完成的再用
 * `compareStableStrings` 比 id 定序。升序即最旧在前，所以条数超限时砍掉开头 `overflow` 条正好砍的是最旧的；
 * id 兜底是为了同毫秒时次序稳定，不随 Map 的遍历顺序漂。
 */
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

/**
 * 把「输出制品没读全」这件事作为一行追加到输出正文末尾；`error` 缺席或全空白就原样返回，不加任何东西。
 * 正文不以换行结尾时先补一个换行，免得和最后一行粘成一句。
 * 追进正文而不是只写快照的 `artifactError` 字段，是为了让读这段输出的一方在正文里就知道它可能不完整。
 */
export function appendArtifactError(output: string, error: LooseOptional<string>): string {
  const normalizedError = error?.trim()
  if (!normalizedError) return output

  const separator = output && !output.endsWith('\n') ? '\n' : ''
  return `${output}${separator}以上输出可能不完整，输出制品没读全：${normalizedError}`
}
