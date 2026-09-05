import type { ToolCapabilitySchema } from '@velaros-ai/agent/protocol'
import { isArray, isEmpty,isPlainObject } from '@velaros-ai/core'

import { compareStableStrings } from '../agent/context/residency/determinism'

export interface KernelToolLoopGuardInput {
  toolName: string
  args: Record<string, unknown>
  writeLike: boolean
}

export interface KernelToolFailureBatchEntry {
  toolName: string
  error: string
}

function stableStringify(value: unknown): string {
  if (isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort((left, right) => compareStableStrings(left, right))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
  }

  return JSON.stringify(value)
}

function buildSuccessKey(input: KernelToolLoopGuardInput): string {
  return `${input.toolName}:${stableStringify(input.args)}`
}

function buildFailureBatchKey(batch: readonly KernelToolFailureBatchEntry[]): string {
  return stableStringify(
    batch.map((entry) => ({
      toolName: entry.toolName,
      error: entry.error,
    }))
  )
}

/**
 * 「写型」判定：**只认声明，不认名字**。
 *
 * `toolName` / `args` 是刻意收下但**不参与判定**的——调用点按与 {@link KernelToolLoopGuardInput}
 * 一致的形状统一传入，判定却必须只看工具自己声明的权限位与 `writeScopes`。一旦回落成按名字猜
 * （`startsWith('write')` 之类），mod 贡献的工具和改过名的内置工具会立刻误判，而误判方向是
 * **放过**（写型当只读 → 重复写闸不生效），属失败方向不安全。
 */
function isKernelWriteLikeTool(input: {
  toolName: string
  args?: LooseOptional<Record<string, unknown>>
  permissions?: LooseOptional<readonly string[]>
  capabilities?: LooseOptional<ToolCapabilitySchema>
}): boolean {
  if (input.permissions?.some((permission) => permission.endsWith(':write'))) return true
  return !!input.capabilities?.writeScopes?.length
}

class KernelToolLoopGuard {
  private lastWriteSuccess: Nullable<{ key: string; count: number }> = null
  private lastFailureBatchKey: Nullable<string> = null
  private lastFailureBatchCount = 0

  public checkRepeatedWriteLikeSuccess(input: KernelToolLoopGuardInput): Nullable<string> {
    if (!input.writeLike) return null

    const key = buildSuccessKey(input)
    const count = this.lastWriteSuccess?.key === key ? this.lastWriteSuccess.count : 0
    if (count < 2) return null

    return `Tool "${input.toolName}" with the same arguments already succeeded 2 times. Stop repeating the write and inspect the current state before trying again.`
  }

  public recordSuccess(input: KernelToolLoopGuardInput): void {
    // A successful inspection or a different mutation gives the agent a new
    // state to act on. Keep only the current write streak, bounded for long runs.
    if (!input.writeLike) {
      this.lastWriteSuccess = null
      return
    }

    const key = buildSuccessKey(input)
    this.lastWriteSuccess = {
      key,
      count: this.lastWriteSuccess?.key === key ? this.lastWriteSuccess.count + 1 : 1,
    }
  }

  public recordFailureBatch(
    batch: readonly KernelToolFailureBatchEntry[]
  ): Nullable<string> {
    if (isEmpty(batch)) {
      this.lastFailureBatchKey = null
      this.lastFailureBatchCount = 0
      return null
    }

    const key = buildFailureBatchKey(batch)
    if (key === this.lastFailureBatchKey) {
      this.lastFailureBatchCount += 1
    } else {
      this.lastFailureBatchKey = key
      this.lastFailureBatchCount = 1
    }

    if (this.lastFailureBatchCount < 3) return null

    return `The same tool failure batch failed 3 times in a row. Stop retrying the same calls, inspect the failure cause, and choose a different repair path.`
  }
}

export { isKernelWriteLikeTool, KernelToolLoopGuard }
