import { isArray, isEmpty,isPlainObject } from '@velaros-ai/core'
import type { ToolCapabilitySchema } from '@velaros-ai/core/types'

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
      .sort((left, right) => left.localeCompare(right))
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

function isKernelWriteLikeTool(input: {
  toolName: string
  args?: LooseOptional<Record<string, unknown>>
  permissions?: LooseOptional<readonly string[]>
  capabilities?: LooseOptional<ToolCapabilitySchema>
}): boolean {
  void input.toolName
  void input.args
  if (input.permissions?.some((permission) => permission.endsWith(':write'))) return true
  return !!input.capabilities?.writeScopes?.length
}

class KernelToolLoopGuard {
  private readonly writeSuccessCounts = new Map<string, number>()
  private lastFailureBatchKey: Nullable<string> = null
  private lastFailureBatchCount = 0

  public checkRepeatedWriteLikeSuccess(input: KernelToolLoopGuardInput): Nullable<string> {
    if (!input.writeLike) return null

    const count = this.writeSuccessCounts.get(buildSuccessKey(input)) ?? 0
    if (count < 2) return null

    return `Tool "${input.toolName}" with the same arguments already succeeded 2 times. Stop repeating the write and inspect the current state before trying again.`
  }

  public recordSuccess(input: KernelToolLoopGuardInput): void {
    if (!input.writeLike) return

    const key = buildSuccessKey(input)
    this.writeSuccessCounts.set(key, (this.writeSuccessCounts.get(key) ?? 0) + 1)
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
