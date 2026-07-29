/**
 * 紧凑工具调用行（单行工具结果展示）。
 *
 * 样式：`.velar-compact-tool-row-neutral` · 见 styles/components/。
 */
import React, { memo, useEffect, useRef, useState } from 'react'

import { cn } from '@velaros-ai/ui/lib/cn'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'

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
  fullDetail: string | undefined
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
    className,
    ...props
  }: CompactToolRowProps): React.ReactElement => {
    const detailRef = useRef<HTMLSpanElement>(null)
    const fullDetail = detailTitle?.trim()
    const detailOverflowing = useDetailOverflow(detailRef, detail, fullDetail)
    const bubbleDisabled = !detailOverflowing || !fullDetail

    // 气泡走 portal 到 body 的 Tooltip：行内绝对定位气泡会被祖先 overflow(工具组行/折叠容器)剪裁而弹不出来。
    return (
      <BubbleTooltip
        content={fullDetail}
        disabled={bubbleDisabled}
        contentClassName="velar-compact-tool-row-detail-tooltip"
      >
        <div
          className={cn('velar-compact-tool-row', toneClassMap[tone], className)}
          data-overflowing={detailOverflowing || undefined}
          {...props}
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
            <span className="velar-compact-tool-row-count" title={countTitle}>
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
      </BubbleTooltip>
    )
  }
)

CompactToolRow.displayName = 'CompactToolRow'
