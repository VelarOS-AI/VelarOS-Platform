import { isEmpty } from '@velaros-ai/core'

import type { ToolContext } from './Types'

/** coding 工具共用的结果裁剪和改动路径推断 helper。 */
class CodingToolHelper {
  /** 解析当前需要关注的改动路径；显式入参优先，其次 session 记录，最后回退 Git。 */
  public async resolveChangedPaths(
    ctx: ToolContext,
    changedPaths?: string[],
    cwd?: string
  ): Promise<string[]> {
    if (changedPaths && !isEmpty(changedPaths)) {
      // 去重后返回，避免验证计划重复处理同一路径。
      return Array.from(new Set(changedPaths))
    }

    const snapshot = ctx.codingSession.getSnapshot()
    // 没有 cwd 时可以直接信任当前 coding session 记录的修改路径。
    if (!cwd && !isEmpty(snapshot.modifiedPaths)) return snapshot.modifiedPaths

    // 传了 cwd 或 session 没记录时，读取 Git 变更作为兜底。
    const changedEntries = cwd
      ? await ctx.workspace.runInDirectory(cwd, () => ctx.workspace.listChangedFiles())
      : await ctx.workspace.listChangedFiles()
    return changedEntries.map((entry) => entry.path)
  }

  /** 简单截断数组结果，并返回 truncated 标记。 */
  public limitResults<T>(items: T[], limit: number): { results: T[]; truncated: boolean } {
    return {
      results: items.slice(0, limit),
      truncated: items.length > limit,
    }
  }

  /**
   * 分段输出结果：前 fullCount 条保留完整对象，后续压缩成 compact 形态。
   *
   * 这样既能给模型足够的前几条上下文，又能避免大量搜索/Git 结果撑爆工具输出。
   */
  public splitResults<T extends object, TCompact extends object>(
    items: T[],
    fullCount: number,
    formatCompact: (item: T) => TCompact
  ): { results: Array<T | TCompact>; truncated: boolean } {
    if (items.length <= fullCount) return {
        results: items,
        truncated: false,
      }

    return {
      results: [...items.slice(0, fullCount), ...items.slice(fullCount).map(formatCompact)],
      truncated: true,
    }
  }
}

/** 默认单例，工具模块直接复用。 */
export const codingToolHelper = new CodingToolHelper()
