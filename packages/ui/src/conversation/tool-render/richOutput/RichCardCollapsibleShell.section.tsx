import React from 'react'
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import styles from './RichOutputToolRender.module.css'

const cx = StyleUtils.bindCx(styles)

export type RichCardCollapsibleTone = 'neutral' | 'running' | 'success' | 'warning' | 'error'

export interface RichCardCollapsibleShellProps {
  rootRef: React.RefCallback<HTMLDivElement> | React.RefObject<Nullable<HTMLDivElement>>
  tone: RichCardCollapsibleTone
  isExpanded: boolean
  icon: React.ReactNode
  title: string
  subtitle?: string
  badge?: LooseOptional<string>
  collapseAriaLabel: string
  onToggleExpand: () => void
  actions?: React.ReactNode
  shouldRenderBody: boolean
  shouldShowBody: boolean
  bodyHeight: number
  bodyRef: React.RefCallback<HTMLDivElement> | React.RefObject<Nullable<HTMLDivElement>>
  children?: React.ReactNode
}

export function RichCardCollapsibleShell({
  rootRef,
  tone,
  isExpanded,
  icon,
  title,
  subtitle,
  badge,
  collapseAriaLabel,
  onToggleExpand,
  actions,
  shouldRenderBody,
  shouldShowBody,
  bodyHeight,
  bodyRef,
  children,
}: RichCardCollapsibleShellProps): React.ReactElement {
  return (
    <div ref={rootRef} className={cx('root', tone, !isExpanded && 'collapsed')}>
      <div className={styles.header}>
        <Button
          variant="ghost"
          size="block"
          className={styles.headerButton}
          aria-expanded={isExpanded}
          aria-label={collapseAriaLabel}
          onClick={onToggleExpand}
        >
          <span className={styles.leadingIcon}>{icon}</span>
          <span className={styles.titleGroup}>
            <span className={styles.titleRow}>
              <Text className={styles.titleText}>{title}</Text>
              {badge && (
                <Badge variant="secondary" className={styles.badge}>
                  {badge}
                </Badge>
              )}
            </span>
            {subtitle && <Text className={styles.subtitle}>{subtitle}</Text>}
          </span>
          <span className={styles.caret} aria-hidden="true">
            {isExpanded ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
          </span>
        </Button>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {shouldRenderBody ? (
        <div ref={bodyRef} className={styles.body}>
          {children}
        </div>
      ) : (shouldShowBody && bodyHeight > 0) && (
        <div className={styles.bodyPlaceholder} style={{ height: bodyHeight }} />
      )}
    </div>
  )
}
