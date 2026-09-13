/**
 * 紧凑工具调用行（单行工具结果展示）。
 *
 * 样式：`.velar-compact-tool-row-neutral` · 见 styles/components/。
 */
import React, { memo, useEffect, useRef, useState } from 'react'

import { cn } from '@velaros-ai/ui/lib/cn'
import { HoverCard } from '@velaros-ai/ui/primitives/overlays/HoverCard'

export interface CompactToolRowProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: React.ReactNode
  label: React.ReactNode
  detail?: React.ReactNode
  detailTitle?: string
  count?: React.ReactNode
  countTitle?: string
  action?: React.ReactNode
  actionLayout?: 'inline' | 'overlay'
  tone?: 'neutral' | 'running' | 'success' | 'warning' | 'error'
  /**
   * 悬停或键盘聚焦行时弹出的可悬停详情（HoverCard）。提供后行可聚焦、不论 detail 是否截断都能弹出，
   * 并丢弃行与计数上的原生 title，免得两层提示叠在一起。不提供时同一个气泡只在 detail 被截断时弹出全文；
   * 详情与行上文字完全重复时就别提供，行上看得全便不必弹。两种内容共用一个包裹层，中途切换不会重挂整行。
   */
  hoverContent?: React.ReactNode
}

const toneClassMap: Record<NonNullable<CompactToolRowProps['tone']>, string> = {
  neutral: 'velar-compact-tool-row-neutral',
  running: 'velar-compact-tool-row-running',
  success: 'velar-compact-tool-row-success',
  warning: 'velar-compact-tool-row-warning',
  error: 'velar-compact-tool-row-error',
}

function normalizeMeasuredText(text: Nullable<string>): string {
  return (text ?? '').replaceAll(/\s+/g, ' ').trim()
}

/** 行内可见文本是否比 fullDetail 少：CSS 溢出、亚像素溢出，或上游只渲染了全文的截断预览。 */
function isDetailTruncated(detailNode: HTMLElement, fullDetail: string): boolean {
  if (detailNode.scrollWidth > detailNode.clientWidth) return true

  // scrollWidth/clientWidth 都按整数取整，溢出不足 1px 时省略号已出现而差值为 0，用 Range 量小数宽度兜底。
  const range = detailNode.ownerDocument.createRange()
  range.selectNodeContents(detailNode)
  if (range.getBoundingClientRect().width - detailNode.getBoundingClientRect().width > 0.5)
    return true

  // 合并行只预览前几项并手工加省略号，行内没有 CSS 溢出；可见文本是全文的真前缀时同样需要气泡。
  const visibleText = normalizeMeasuredText(detailNode.textContent)
    .replace(/…+$/, '')
    .trimEnd()
  const fullText = normalizeMeasuredText(fullDetail)
  return fullText.length > visibleText.length && fullText.startsWith(visibleText)
}

function useDetailOverflow(
  detailRef: React.RefObject<Nullable<HTMLSpanElement>>,
  detail: React.ReactNode,
  fullDetail: Optional<string>
): boolean {
  const [detailOverflowing, setDetailOverflowing] = useState(false)

  useEffect(() => {
    const detailNode = detailRef.current
    if (!detailNode || !fullDetail) {
      setDetailOverflowing(false)
      return undefined
    }

    const measureOverflow = (): void => {
      setDetailOverflowing(isDetailTruncated(detailNode, fullDetail))
    }

    measureOverflow()

    let disposed = false
    // 字体晚于首次测量就绪时内容宽度会变而节点盒子不变，ResizeObserver 收不到通知，补测一次。
    void detailNode.ownerDocument.fonts?.ready.then(() => {
      if (!disposed) measureOverflow()
    })

    const win = globalThis.window
    const parentNode = detailNode.parentElement
    if (!win?.ResizeObserver) {
      win?.addEventListener('resize', measureOverflow)
      return () => {
        disposed = true
        win?.removeEventListener('resize', measureOverflow)
      }
    }

    const observer = new win.ResizeObserver(measureOverflow)
    observer.observe(detailNode)
    if (parentNode) observer.observe(parentNode)
    win.addEventListener('resize', measureOverflow)

    return () => {
      disposed = true
      observer.disconnect()
      win.removeEventListener('resize', measureOverflow)
    }
  }, [detail, detailRef, fullDetail])

  return detailOverflowing
}

export const CompactToolRow = memo(
  ({
    icon,
    label,
    detail,
    detailTitle,
    count,
    countTitle,
    action,
    actionLayout = 'inline',
    tone = 'neutral',
    hoverContent,
    className,
    title,
    ...props
  }: CompactToolRowProps): React.ReactElement => {
    const detailRef = useRef<HTMLSpanElement>(null)
    const fullDetail = detailTitle?.trim()
    const hasHoverContent = !!hoverContent
    // 有详情气泡时不再需要截断全文气泡，也就不必给每一行挂尺寸观察器去量是否溢出。
    const detailOverflowing = useDetailOverflow(
      detailRef,
      detail,
      hasHoverContent ? undefined : fullDetail
    )
    // 没有详情时退回「detail 被截断才弹全文」：气泡内容就是完整的 detail，行上看得全就不弹。
    const bubbleContent = hasHoverContent
      ? hoverContent
      : detailOverflowing && !!fullDetail && (
          <span className="velar-compact-tool-row-detail-full">{fullDetail}</span>
        )

    const row = (
      <div
        className={cn('velar-compact-tool-row', toneClassMap[tone], className)}
        data-overflowing={detailOverflowing || undefined}
        tabIndex={hasHoverContent ? 0 : undefined}
        {...props}
        title={hasHoverContent ? undefined : title}
      >
        <span className="velar-compact-tool-row-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="velar-compact-tool-row-label">{label}</span>
        {detail ? (
          <span
            ref={detailRef}
            className="velar-compact-tool-row-detail"
            aria-label={fullDetail}
          >
            {detail}
          </span>
        ) : (
          <span ref={detailRef} className="velar-compact-tool-row-detail" aria-hidden="true" />
        )}
        {!!count && (
          <span
            className="velar-compact-tool-row-count"
            title={hasHoverContent ? undefined : countTitle}
          >
            {count}
          </span>
        )}
        {!!action && (
          <span
            className={cn(
              'velar-compact-tool-row-action-slot',
              actionLayout === 'overlay' && 'velar-compact-tool-row-action-slot-overlay'
            )}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {action}
          </span>
        )}
      </div>
    )

    // 气泡 portal 到 body：行内绝对定位气泡会被祖先 overflow(工具组行/折叠容器)剪裁而弹不出来。
    // 详情与截断全文共用同一个 HoverCard：与行等宽、带指向行的箭头，行宽随分隔条、窗口变化时一起变；
    // 包裹层始终是它，详情有无切换时只换内容，不重挂整行。
    return (
      <HoverCard content={bubbleContent} widthStrategy="anchor">
        {row}
      </HoverCard>
    )
  }
)

CompactToolRow.displayName = 'CompactToolRow'
