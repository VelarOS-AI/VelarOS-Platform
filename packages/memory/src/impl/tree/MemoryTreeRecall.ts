/**
 * 记忆树 v1 的召回薄壳：`MemoryTreeRecall`。接口 `MemoryTreeRecallApi` 在本文件的类上方。
 * 它只判定这次召回算哪种检索方式，查询本身全在 `MemoryTreeRepository` 里。
 */

import { isBlank } from '@velaros-ai/core'

import type { MemoryRecallItem, MemoryRecallOptions } from '../../types/memory'

import { type MemoryTreeRepository } from './MemoryTreeRepository'

/**
 * 记忆树 v1 的召回入口：查一遍仓，并给每条结果标上它是怎么被找出来的。
 *
 * 实现是 `MemoryTreeRecall`，由 `MemoryTreeDomain` 独占持有，不出包。
 */
export interface MemoryTreeRecallApi {
  /**
   * 按查询词与作用域召回主张，并标上检索方式：`deep` 深层回忆、空查询按作用域或最近、其余按文本命中。
   * 查询词两端的空白会先去掉；仓里一条都没命中时返回空数组，不抛错。
   */
  recall(query: string, options?: MemoryRecallOptions): MemoryRecallItem[]
}

export class MemoryTreeRecall implements MemoryTreeRecallApi {
  constructor(private readonly repository: MemoryTreeRepository) {}

  public recall(query: string, options: MemoryRecallOptions = {}): MemoryRecallItem[] {
    const normalizedQuery = query.trim()
    const rows = this.repository.recall(normalizedQuery, options)
    const reason: MemoryRecallItem['retrievalReason'] = options.deep
      ? 'deep'
      : isBlank(normalizedQuery)
        ? options.workspaceRoot || options.scopeId
          ? 'scope'
          : 'recent'
        : 'text'
    return this.repository.toRecallItems(rows, reason)
  }
}
