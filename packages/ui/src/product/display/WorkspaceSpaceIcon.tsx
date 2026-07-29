/**
 * 工作区分类图标：把**空间 descriptor 声明的图标语义名**映射到具体图标资产。
 *
 * 空间可组装（宪章 §2）：本库不认识产品空间枚举，也不再平行维护一份「空间 → 图标名」的
 * switch（那份与宿主 `SpaceDescriptor.iconName` 靠人工同步，必漂）。宿主直接把
 * `descriptor.iconName` 递进来；新空间声明 iconName 即接入，本文件零改动。
 *
 * variants（封闭枚举，全仓共用一套）：`iconName` = `desktop | folder-open | browser`。
 * 品牌端口：browser 图标名的具体资产由宿主经 `renderBrowserIcon` 注入——本库不承载产品品牌资产。
 */
import { type ReactElement } from 'react'
import { DesktopIcon, FolderOpenIcon, type IconWeight } from '@phosphor-icons/react'

/** 空间 descriptor 的图标语义名词表（宿主声明轴，与本库的资产映射一一对应）。 */
export type WorkspaceSpaceIconName = 'desktop' | 'folder-open' | 'browser'

export interface WorkspaceSpaceIconProps {
  iconName: WorkspaceSpaceIconName
  size?: number
  weight?: IconWeight
  /** browser 图标名的品牌资产注入点：由宿主提供，本库不直依产品品牌资产。 */
  renderBrowserIcon: (props: { size: number }) => ReactElement
}

export function WorkspaceSpaceIcon({
  iconName,
  size = 13,
  weight,
  renderBrowserIcon,
}: WorkspaceSpaceIconProps): ReactElement {
  // 未识别名回落桌面图标（= system 默认），拒绝把未知空间渲染成空洞。
  switch (iconName) {
    case 'folder-open':
      return <FolderOpenIcon size={size} weight={weight} />
    case 'browser':
      return renderBrowserIcon({ size })
    case 'desktop':
    default:
      return <DesktopIcon size={size} weight={weight} />
  }
}
