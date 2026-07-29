/**
 * 工作区分类图标 + 执行态色调：在 `WorkspaceSpaceIcon` 外裹一层承担运行 / 暂停态提示。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `default | running | paused`。
 * 样式：`.velar-space-status-icon` · 见 styles/components/。
 * 品牌端口：browser 分类品牌图标经 `renderBrowserIcon` 由宿主注入（透传给 WorkspaceSpaceIcon）。
 */
import { type ReactElement } from 'react'

import { cn } from '../../lib/cn'

import {
  WorkspaceSpaceIcon,
  type WorkspaceSpaceKind,
} from './WorkspaceSpaceIcon'

export type WorkspaceSpaceStatusTone = 'default' | 'running' | 'paused'

export interface WorkspaceSpaceStatusIconProps {
  space: WorkspaceSpaceKind
  running?: boolean
  tone?: WorkspaceSpaceStatusTone
  /** browser 分类的品牌图标注入点：由宿主提供，透传给内部 WorkspaceSpaceIcon。 */
  renderBrowserIcon: (props: { size: number }) => ReactElement
}

export function WorkspaceSpaceStatusIcon({
  space,
  running = false,
  tone = running ? 'running' : 'default',
  renderBrowserIcon,
}: WorkspaceSpaceStatusIconProps): ReactElement {
  return (
    <span
      className={cn(
        'velar-space-status-icon',
        tone === 'running' && 'velar-space-status-icon-running',
        tone === 'paused' && 'velar-space-status-icon-paused'
      )}
      data-tone={tone}
      aria-hidden="true"
    >
      <WorkspaceSpaceIcon
        space={space}
        size={11}
        weight="bold"
        renderBrowserIcon={renderBrowserIcon}
      />
    </span>
  )
}
