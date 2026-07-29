/**
 * 设置页版式：分节 + 设置行。
 *
 * 样式：`.velar-settings-section` · 见 styles/components/。
 */
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  memo,
  type ReactElement,
  type ReactNode,
} from 'react'

import { cn } from '@velaros-ai/ui/lib/cn'
export interface SettingsSectionProps extends ComponentPropsWithoutRef<'section'> {
  title: string
  description?: string
  /** 展示在分区标题右侧的行内控件，例如刷新按钮。 */
  titleAddon?: ReactNode
}

export const SettingsSection = memo(({
  title,
  description,
  titleAddon,
  className,
  children,
  ...props
}: SettingsSectionProps): ReactElement => (
  <section data-slot="settings-section" className={cn('velar-settings-section', className)} {...props}>
    <div className={'velar-settings-section-header'}>
      <div className={'velar-settings-section-title-row'}>
        <h2 className={'velar-settings-section-title'}>{title}</h2>
        {!!titleAddon && <div className={'velar-settings-section-title-addon'}>{titleAddon}</div>}
      </div>
      {!!description && <p className={'velar-settings-section-description'}>{description}</p>}
    </div>
    {children}
  </section>
))

SettingsSection.displayName = 'SettingsSection'

export const SettingsCard = memo(forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(({
  className,
  ...props
}, ref): ReactElement => (
  <div
    ref={ref}
    data-slot="settings-card"
    className={cn('velar-settings-card', className)}
    {...props}
  />
)))

SettingsCard.displayName = 'SettingsCard'

export interface SettingsRowProps extends ComponentPropsWithoutRef<'div'> {
  title: string
  description?: string
  action?: ReactNode
}

export const SettingsRow = memo(({
  title,
  description,
  action,
  className,
  children,
  ...props
}: SettingsRowProps): ReactElement => (
  <div data-slot="settings-row" className={cn('velar-settings-row', className)} {...props}>
    <div className={'velar-settings-row-meta'}>
      <div className={'velar-settings-row-title-wrap'}>
        <p className={'velar-settings-row-title'}>{title}</p>
        {!!action && <span className={'velar-settings-row-action'}>{action}</span>}
      </div>
      {!!description && <p className={'velar-settings-row-description'}>{description}</p>}
    </div>
    <div className={'velar-settings-row-control'}>{children}</div>
  </div>
))

SettingsRow.displayName = 'SettingsRow'
