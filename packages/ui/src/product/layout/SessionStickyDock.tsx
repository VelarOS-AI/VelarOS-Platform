/**
 * 会话级固定坞：在对话顶部固定一组可插入的业务卡片，支持整体折叠 / 自动展开。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | side`（匹配对话面板密度，抵消顶 padding）。
 * 样式：`.velar-session-sticky-dock` · 见 styles/components/。
 * 注入：`barLabel`（无障碍条标签，由宿主注入 i18n 文案，本库不承载文案）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CaretDoubleDownIcon } from '@phosphor-icons/react'
import type { ReactElement, ReactNode } from 'react'

import { cn } from '../../lib/cn'

const EmptySpotlightItemIds: string[] = []

export interface SessionStickyDockItem {
  id: string
  content: ReactNode
  createdAt?: number
}

export interface SessionStickyDockProps {
  items: SessionStickyDockItem[]
  /** 无障碍条标签（宿主注入 i18n 文案）。 */
  barLabel: string
  /** 初始是否收起；组件库 fixture 可传 false 展示展开态。 */
  initialCollapsed?: boolean
  /** 变化时自动展开一次；用于计划更新这类临时顶层提示。 */
  autoRevealKey?: string
  /** 变化时强制收起一次；用于目标进入完成等终态时关闭仍残留的计划卡。 */
  autoCollapseKey?: string
  /** 自动展开期间只展示这些条目；用户手动展开时仍展示全部。 */
  spotlightItemIds?: string[]
  /** 与 ChatConversationPane variant 一致，用于抵消 messageListInner 的顶 padding。 */
  variant?: 'default' | 'side'
}

export function SessionStickyDock({
  autoCollapseKey,
  autoRevealKey,
  barLabel,
  initialCollapsed = true,
  items,
  spotlightItemIds = EmptySpotlightItemIds,
  variant = 'default',
}: SessionStickyDockProps): Nullable<ReactElement> {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [spotlightActive, setSpotlightActive] = useState(false)
  const prevLenRef = useRef(0)
  const prevAutoRevealKeyRef = useRef<string | undefined>(autoRevealKey)
  const prevAutoCollapseKeyRef = useRef<string | undefined>(autoCollapseKey)
  const skipMountPeekRef = useRef(true)
  const spotlightIdSet = useMemo(() => new Set(spotlightItemIds), [spotlightItemIds])

  useEffect(() => {
    if (items.length === 0) {
      setCollapsed(true)
      setSpotlightActive(false)
    }
  }, [items.length])

  useEffect(() => {
    if (autoRevealKey) {
      prevLenRef.current = items.length
      return
    }
    if (skipMountPeekRef.current) {
      skipMountPeekRef.current = false
      prevLenRef.current = items.length
      return
    }
    if (items.length > prevLenRef.current) {
      setCollapsed(false)
      setSpotlightActive(false)
    }
    prevLenRef.current = items.length
  }, [autoRevealKey, items.length])

  useEffect(() => {
    if (!autoRevealKey) {
      prevAutoRevealKeyRef.current = autoRevealKey
      setSpotlightActive(false)
      return
    }

    if (autoRevealKey === prevAutoRevealKeyRef.current) return

    prevAutoRevealKeyRef.current = autoRevealKey
    setCollapsed(false)
    setSpotlightActive(spotlightIdSet.size > 0)
  }, [autoRevealKey, spotlightIdSet])

  useEffect(() => {
    if (!autoCollapseKey || autoCollapseKey === prevAutoCollapseKeyRef.current) return

    prevAutoCollapseKeyRef.current = autoCollapseKey
    setCollapsed(true)
    setSpotlightActive(false)
  }, [autoCollapseKey])

  if (items.length === 0) return null

  const handleTriggerClick = (): void => {
    setSpotlightActive(false)
    setCollapsed((value) => !value)
  }
  const visibleItems =
    spotlightActive && spotlightIdSet.size > 0
      ? items.filter((item) => spotlightIdSet.has(item.id))
      : items

  return (
    <section
      className={cn('velar-session-sticky-dock', variant === 'side' && 'velar-session-sticky-dock-side')}
      aria-label={barLabel}
    >
      <div className="velar-session-sticky-dock-layer">
        <div className={cn('velar-session-sticky-dock-curtain', !collapsed && 'velar-session-sticky-dock-curtain-open')}>
          <div className="velar-session-sticky-dock-fabric-clip">
            <div className="velar-session-sticky-dock-fabric">
              <div className="velar-session-sticky-dock-fabric-inner">
                {visibleItems.map((entry) => (
                  <div key={entry.id} className="velar-session-sticky-dock-item">
                    {entry.content}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="velar-session-sticky-dock-trigger"
            onClick={handleTriggerClick}
            aria-expanded={!collapsed}
          >
            <span className="velar-session-sticky-dock-trigger-center" aria-hidden>
              <span
                className={cn(
                  'velar-session-sticky-dock-trigger-flip',
                  !collapsed && 'velar-session-sticky-dock-trigger-flip-open'
                )}
              >
                <CaretDoubleDownIcon className="velar-session-sticky-dock-chevron" weight="bold" />
              </span>
            </span>
          </button>
        </div>
      </div>
    </section>
  )
}
