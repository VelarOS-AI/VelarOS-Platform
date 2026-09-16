/**
 * 定义记忆工具的辅助函数。
 *
 * 全部工具定义都写在 `impl/MemoryTools.ts` 里，这里只放定义用的那一个函数。
 */

import { toolContracts } from '@velaros-ai/tool-contract'

import type { VelaTool } from '../contract/requires'
import type { DefineMemoryToolInput } from '../types/tool'

/** 定义一个记忆工具：把工具契约 SDK 的通用定义收窄到记忆的上下文与类别上。 */
export function defineMemoryTool<
  TInput extends Record<string, unknown>,
>(
  input: DefineMemoryToolInput<TInput>
): VelaTool<TInput> {
  return toolContracts.defineRuntime(input)
}
