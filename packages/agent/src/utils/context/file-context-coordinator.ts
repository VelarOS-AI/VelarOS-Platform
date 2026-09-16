// FileContextCoordinator 用到的纯函数（不碰实例状态）。
import { isEmpty } from '@velaros-ai/core'

import type { FileContextCarrier, FileContextSource, FileContextView, FileContextViewTier } from '../../types/context.js'

/** 文件上下文的索引键：来源作用域 id 加路径。 */
export function key(workspaceId: string, path: string): string {
  return JSON.stringify([workspaceId, path])
}

/** 显式读取过的文件不会被顺带观察降级；刷新沿用原层级。 */
export function resolveViewTier(
  previous: Optional<FileContextView>,
  requested?: FileContextViewTier
): FileContextViewTier {
  if (previous && (previous.tier ?? 'requested') === 'requested') return 'requested'
  return requested ?? previous?.tier ?? 'requested'
}

/** 视图层级的排序权重：顺带观察的排在显式读取之后。 */
export function tierRank(view: FileContextView): number {
  return view.tier === 'incidental' ? 0 : 1
}

/**
 * 子分支是否还看得见这个来源里读文件的工具：看不见就不继承它的访问口。
 *
 * 名单只认来源自己登记的 `fileAccessToolNames`——Agent 不持有任何空间的工具名，也就不会写出一个
 * 早已不存在的名字还以为判得准。来源没声明名单、或子分支报不出可见工具时不设这道闸（判不了就不撤权）。
 */
export function childKeepsFileSources(child: FileContextCarrier, source: FileContextSource): boolean {
  const declared = source.fileAccessToolNames
  if (!declared || isEmpty(declared) || !child.getCurrentVisibleToolNames) return true
  const visible = new Set(child.getCurrentVisibleToolNames())
  return declared.some((name) => visible.has(name))
}
