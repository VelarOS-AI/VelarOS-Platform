import { isFiniteNumber } from '@velaros-ai/core'

import type { KernelContextEpoch } from '../../types/loop.js'
import { compareStableStrings } from '../residency/determinism'

/**
 * 纪元账本的索引键：`scope ?? sessionId` 加 `phase`。
 *
 * 子 Agent 带自己的 scope（threadId），所以父子并发各占一格、互不作废；去掉 scope 就会让并发子 Agent
 * 互相踩废对方在途的请求。同一把键上的修订号只增不减，新一次 claim 让旧的立即失效（后来者赢）。
 */
export function resolveKernelContextEpochKey(epoch: KernelContextEpoch): string {
  return [epoch.scope ?? epoch.sessionId, epoch.phase].join(':')
}

/** P7-2：epoch 指纹里的清单序必须 locale 无关（码元序），否则同一份上下文跨机器判成"变了"。 */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    compareStableStrings
  )
}

/**
 * 把 epoch 的必填标识（sessionId、model）去空白后收成非空串；整串空白或空串时用 fallback 顶上
 * （如 `unknown-model`）。保证同一会话每次 claim 都落在同一个键上，不会因为宿主传了个空串而
 * 凭空多出一格谁也对不上的纪元。
 */
export function normalizeLabel(value: string, fallback: string): string {
  return value.trim() || fallback
}

/**
 * 把可选标识（scope）去空白：为空返回 `null` 而不是空串。差别是实打实的——`null` 在
 * `resolveKernelContextEpochKey` 里会回落到 sessionId（父面共用一格），空串则会造出一格独立的
 * 假 scope，让父面的 claim 再也作废不掉在途请求。
 */
export function normalizeOptionalLabel(value: LooseOptional<string>): Nullable<string> {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

/**
 * 把可选计数（turn）收成非负整数：非有限数或负数一律返回 `null`，表示「这次 claim 没有轮次概念」。
 * 不夹到 0——0 是「第 0 轮」，与「没有轮次」在 epoch 比对里含义不同。
 */
export function normalizeOptionalNonNegativeInteger(value: LooseOptional<number>): Nullable<number> {
  if (!isFiniteNumber(value) || value < 0) return null
  return Math.floor(value)
}

/**
 * 把必填计数（messageCount、estimatedTokens、createdAt）收成非负整数：非有限数按 0，负数夹到 0，
 * 小数向下取整。宿主给的估算再离谱也不让 NaN 流进 epoch 快照——NaN 会让后续的等值比对永远为假。
 */
export function normalizeNonNegativeInteger(value: number): number {
  if (!isFiniteNumber(value)) return 0
  return Math.max(0, Math.floor(value))
}

/** 把上下文占用百分比夹进 0–100，非有限数按 0；上游估算越界时不让 epoch 快照跟着失真。 */
export function normalizePercent(value: number): number {
  if (!isFiniteNumber(value)) return 0
  return Math.min(100, Math.max(0, value))
}
