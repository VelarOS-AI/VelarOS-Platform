/**
 * 锚定浮层的定位几何（纯函数）：给定触发元素与浮层的尺寸、视口和方向，算出浮层落在哪里、宽度怎么约束，
 * 以及触发元素的中心落在浮层内的哪个位置——浮层据此把指向触发元素的箭头画对地方。
 * 不碰 DOM 与 React，定位规则可以脱离浏览器验证；Popover 负责量尺寸、在滚动与缩放时重算。
 */
import { isPresent, optionalWhen } from '../../lib/runtime'

export type PopoverSide = 'top' | 'right' | 'bottom' | 'left'
export type PopoverAlign = 'start' | 'center' | 'end'
export type PopoverWidthStrategy = 'content' | 'anchor' | 'adaptive'

export interface PopoverBox {
  left: number
  top: number
  width: number
  height: number
}

export interface PopoverPositionInput {
  anchorRect: PopoverBox
  /** 浮层当前量到的尺寸；等宽策略下宽度改用触发元素的宽度。 */
  contentWidth: number
  contentHeight: number
  viewportWidth: number
  viewportHeight: number
  /** 挂载容器不是 body 时容器左上角在视口里的位置：浮层改用容器内的绝对定位。 */
  portalOrigin: Nullable<{ left: number; top: number }>
  widthStrategy: PopoverWidthStrategy
  side: PopoverSide
  align: PopoverAlign
  sideOffset: number
  viewportPadding: number
}

export interface PopoverPosition {
  position: 'fixed' | 'absolute'
  left: number
  top: number
  width?: number
  minWidth?: number
  maxWidth?: number
  /** 触发元素中心相对浮层左上角的横坐标：浮层被视口挤开时箭头仍要指着触发元素。 */
  anchorCenterX: number
  /** 触发元素中心相对浮层左上角的纵坐标。 */
  anchorCenterY: number
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min

  return Math.min(Math.max(value, min), max)
}

export function resolvePopoverPosition({
  anchorRect,
  contentWidth: measuredWidth,
  contentHeight,
  viewportWidth,
  viewportHeight,
  portalOrigin,
  widthStrategy,
  side,
  align,
  sideOffset,
  viewportPadding,
}: PopoverPositionInput): PopoverPosition {
  const maxAvailableWidth = viewportWidth - viewportPadding * 2
  const contentWidth =
    widthStrategy === 'anchor'
      ? anchorRect.width
      : widthStrategy === 'adaptive'
        ? clamp(measuredWidth, anchorRect.width, maxAvailableWidth)
        : measuredWidth
  const anchorRight = anchorRect.left + anchorRect.width
  const anchorBottom = anchorRect.top + anchorRect.height
  let top = anchorBottom + sideOffset
  let left = anchorRect.left

  if (side === 'top') {
    top = anchorRect.top - contentHeight - sideOffset
  } else if (side === 'left') {
    top = anchorRect.top
    left = anchorRect.left - contentWidth - sideOffset
  } else if (side === 'right') {
    top = anchorRect.top
    left = anchorRight + sideOffset
  }

  if (side === 'top' || side === 'bottom') {
    if (align === 'center') {
      left = anchorRect.left + (anchorRect.width - contentWidth) / 2
    } else if (align === 'end') {
      left = anchorRight - contentWidth
    }
  } else if (align === 'center') {
    top = anchorRect.top + (anchorRect.height - contentHeight) / 2
  } else if (align === 'end') {
    top = anchorBottom - contentHeight
  }

  // 视口坐标下的最终位置：先夹进视口，再换算成挂载容器内的坐标。
  const viewportLeft = clamp(left, viewportPadding, viewportWidth - contentWidth - viewportPadding)
  const viewportTop = clamp(top, viewportPadding, viewportHeight - contentHeight - viewportPadding)

  return {
    position: isPresent(portalOrigin) ? 'absolute' : 'fixed',
    left: viewportLeft - (portalOrigin?.left ?? 0),
    top: viewportTop - (portalOrigin?.top ?? 0),
    width: optionalWhen(widthStrategy === 'anchor', anchorRect.width),
    minWidth: optionalWhen(widthStrategy === 'anchor' || widthStrategy === 'adaptive', anchorRect.width),
    maxWidth: optionalWhen(widthStrategy === 'adaptive', maxAvailableWidth),
    anchorCenterX: anchorRect.left + anchorRect.width / 2 - viewportLeft,
    anchorCenterY: anchorRect.top + anchorRect.height / 2 - viewportTop,
  }
}
