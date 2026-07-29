import React, { useEffect, useRef, useState } from 'react'

import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'

import { useConversationI18n, useConversationTranslatorRuntime } from '../../i18n'
import { useIntersectionObserver } from '../../react-hooks/useIntersectionObserver'
import { getToolStatusLabel } from '../toolCallSummary'

import type { RichCardCollapsibleTone } from './RichCardCollapsibleShell.section'
import { RichCardCollapsibleShell } from './RichCardCollapsibleShell.section'

import type { ToolCallBlock } from '#contracts'

export interface RichToolOutputCardProps {
  icon: React.ReactNode
  title: string
  subtitle?: string
  badge?: LooseOptional<string>
  toolBlock?: ToolCallBlock
  tone?: RichCardCollapsibleTone
  compact?: boolean
  actions?: React.ReactNode
  children?: React.ReactNode
}

export function RichToolOutputCard({
  icon,
  title,
  subtitle,
  badge,
  toolBlock,
  tone = 'neutral',
  compact = false,
  actions,
  children,
}: RichToolOutputCardProps): React.ReactElement {
  const { locale, t } = useConversationI18n()
  const translatorRuntime = useConversationTranslatorRuntime()
  const statusLabel = toolBlock
    ? getToolStatusLabel(toolBlock, locale, translatorRuntime)
    : null
  const { ref: rootRef, isIntersecting } = useIntersectionObserver<HTMLDivElement>({
    rootMargin: '720px 0px',
  })
  const [isExpanded, setIsExpanded] = useState(false)
  const [bodyHeight, setBodyHeight] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const shouldShowBody = isExpanded && !!children
  const shouldRenderBody = shouldShowBody && isIntersecting

  useEffect(() => {
    if (!shouldRenderBody) return undefined

    const body = bodyRef.current
    if (!body) return undefined

    const updateBodyHeight = (): void => {
      setBodyHeight(body.offsetHeight)
    }

    updateBodyHeight()

    if (!window.ResizeObserver) return undefined

    const observer = new ResizeObserver(updateBodyHeight)
    observer.observe(body)

    return () => observer.disconnect()
  }, [children, shouldRenderBody])

  if (compact) return (
      <CompactToolRow
        tone={tone}
        icon={icon}
        label={title}
        detail={subtitle}
        detailTitle={subtitle}
        count={statusLabel ?? badge}
      />
    )

  return (
    <RichCardCollapsibleShell
      rootRef={rootRef}
      tone={tone}
      isExpanded={isExpanded}
      icon={icon}
      title={title}
      subtitle={subtitle}
      badge={badge}
      collapseAriaLabel={isExpanded ? t('chat.richCollapse') : t('chat.richExpand')}
      onToggleExpand={() => setIsExpanded((value) => !value)}
      actions={actions}
      shouldRenderBody={shouldRenderBody}
      shouldShowBody={shouldShowBody}
      bodyHeight={bodyHeight}
      bodyRef={bodyRef}
    >
      {children}
    </RichCardCollapsibleShell>
  )
}
