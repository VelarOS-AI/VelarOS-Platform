/**
 * 工作区分类图标：把 `WorkspaceSpaceKind` 映射到固定图标，是工作区图标的单一来源，
 * 与 workspaceSpaceDescriptors 配对；接入新工作区分类时在这里补一项即可。
 *
 * variants（封闭枚举，全仓共用一套）：`space` = `WorkspaceSpaceKind`（system | project | browser）。
 * 品牌端口：browser 分类的品牌标识由宿主经 `renderBrowserIcon` 注入——本库不承载具体产品品牌资产。
 */
import { type ReactElement } from 'react'
import { DesktopIcon, FolderOpenIcon, type IconWeight } from '@phosphor-icons/react'

import {
  getWorkspaceSpaceIconName,
  type WorkspaceSpaceKind,
} from './workspaceSpace'

export type { WorkspaceSpaceKind } from './workspaceSpace'

export interface WorkspaceSpaceIconProps {
  space: WorkspaceSpaceKind
  size?: number
  weight?: IconWeight
  /** browser 分类的品牌图标注入点：由宿主提供，本库不直依产品品牌资产。 */
  renderBrowserIcon: (props: { size: number }) => ReactElement
}

export function WorkspaceSpaceIcon({
  space,
  size = 13,
  weight,
  renderBrowserIcon,
}: WorkspaceSpaceIconProps): ReactElement {
  // 空间可组装（宪章 §2）：图标语义名是空间 descriptor 的声明轴，按 iconName 映射到具体图标资产，
  // 不再按枚举硬分派。新空间声明 iconName 即接入；未识别名回落桌面图标（= system 默认）。
  switch (getWorkspaceSpaceIconName(space)) {
    case 'folder-open':
      return <FolderOpenIcon size={size} weight={weight} />
    case 'browser':
      return renderBrowserIcon({ size })
    case 'desktop':
    default:
      return <DesktopIcon size={size} weight={weight} />
  }
}
