// KernelToolLoopGuard 用到的纯函数（不碰实例状态）。
import { isArray, isPlainObject } from '@velaros-ai/core'

import type { ToolCapabilitySchema } from '../../types/agent.js'
import type { KernelToolFailureBatchEntry, KernelToolLoopGuardInput } from '../../types/tools.js'
import { compareStableStrings } from '../../utils/residency/determinism'

/** 键序稳定的序列化：同内容必同字节，死循环守卫靠它比较两次调用是否一致。 */
export function stableStringify(value: unknown): string {
  if (isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort((left, right) => compareStableStrings(left, right))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
  }

  return JSON.stringify(value)
}

/** 成功调用的去重键：工具名 + 稳定序列化后的入参。 */
export function buildSuccessKey(input: KernelToolLoopGuardInput): string {
  return `${input.toolName}:${stableStringify(input.args)}`
}

/** 一批失败调用的去重键：只取工具名、入参与错误，忽略时间等易变字段。 */
export function buildFailureBatchKey(batch: readonly KernelToolFailureBatchEntry[]): string {
  return stableStringify(
    batch.map((entry) => ({
      toolName: entry.toolName,
      args: entry.args ?? {},
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
export function isKernelWriteLikeTool(input: {
  toolName: string
  args?: LooseOptional<Record<string, unknown>>
  permissions?: LooseOptional<readonly string[]>
  capabilities?: LooseOptional<ToolCapabilitySchema>
}): boolean {
  if (input.permissions?.some((permission) => permission.endsWith(':write'))) return true
  return !!input.capabilities?.writeScopes?.length
}
