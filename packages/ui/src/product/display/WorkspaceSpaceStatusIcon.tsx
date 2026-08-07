/**
 * 工作区分类图标 + 执行态色调：在 `WorkspaceSpaceIcon` 外裹一层承担运行 / 暂停态提示。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `default | running | paused`。
 * 样式：`.velar-space-status-icon` · 见 styles/components/。
 * 品牌端口：browser / agent 分类的品牌图标经 `renderBrowserIcon` / `renderAgentIcon` 由宿主注入
 * （透传给 WorkspaceSpaceIcon；agent 那格可缺席，缺席即回落通用机器人）。
 */
import { type ReactElement } from 'react'

import { cn } from '../../lib/cn'

import { WorkspaceSpaceIcon, type WorkspaceSpaceIconName } from './WorkspaceSpaceIcon'

export type WorkspaceSpaceStatusTone = 'default' | 'running' | 'paused'

export interface WorkspaceSpaceStatusIconProps {
  /** 空间 descriptor 声明的图标语义名（宿主查表后递入，本库不认识空间枚举）。 */
  iconName: WorkspaceSpaceIconName
  running?: boolean
  tone?: WorkspaceSpaceStatusTone
  /** browser 图标名的品牌资产注入点：由宿主提供，透传给内部 WorkspaceSpaceIcon。 */
  renderBrowserIcon: (props: { size: number }) => ReactElement
  /** agent 图标名的品牌资产注入点（可选，缺省回落通用机器人图形）；同样只做透传。 */
  renderAgentIcon?: (props: { size: number }) => ReactElement
}

export function WorkspaceSpaceStatusIcon({
  iconName,
  running = false,
  tone = running ? 'running' : 'default',
  renderBrowserIcon,
  renderAgentIcon,
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
        iconName={iconName}
        size={11}
        weight="bold"
        renderBrowserIcon={renderBrowserIcon}
        renderAgentIcon={renderAgentIcon}
      />
    </span>
  )
}
