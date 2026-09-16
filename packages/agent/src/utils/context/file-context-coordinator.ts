// FileContextCoordinator 用到的纯函数（不碰实例状态）。
import type { FileContextCarrier, FileContextView, FileContextViewTier } from '../../types/context.js'

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

/** 子分支是否还看得见读文件的工具：看不见就不继承父分支的来源访问口。 */
export function childKeepsFileSources(child: FileContextCarrier): boolean {
  if (!child.getCurrentVisibleToolNames) return true
  return child
    .getCurrentVisibleToolNames()
    .some((name) =>
      ['project:read', 'project:search', 'project:code', 'project:write', 'project:edit'].includes(name)
    )
}
