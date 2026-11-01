import { createHash } from 'node:crypto'

import { AppError } from '@velaros-ai/core/error'

import type { RuntimeInstructionBlock, RuntimeInstructionManifest } from '../types/instructions.js'

/** 装配和导出共享同一份正文；启用块按既有分隔符逐字拼接。 */
export function assembleInstructionManifest(
  blocks: ReadonlyArray<Omit<RuntimeInstructionBlock, 'revision'>>
): RuntimeInstructionManifest {
  const ids = new Set<string>()
  const resolved = blocks.map((block) => {
    if (ids.has(block.id)) throw new AppError('INVARIANT', `重复指令块：${block.id}`)
    ids.add(block.id)
    return {
      ...block,
      revision: createHash('sha256').update(block.text).digest('hex'),
    }
  })
  return {
    text: resolved
      .filter((block) => block.enabled)
      .map((block) => block.text)
      .join(''),
    blocks: resolved,
  }
}
