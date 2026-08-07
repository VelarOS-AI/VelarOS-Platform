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

/**
 * 控件槽宽度档。
 *
 * 取代了此前**所有控件一律 212px** 的一刀切（`--settings-row-control-width`）。那条规则用
 * 后代选择器把宽度套到 `[data-slot='input']` 上，于是：`Select` 原生的 `width:fit-content`
 * 被撑成 212px（「中文」两个字占一整条）、`NumberInput` 内部那个 `Input` 也被撑满（数字框
 * 长得和文本框一样）、长 URL 反而在 212px 里被截断、只要 44px 的 `Switch` 也占着整槽。
 *
 * 现在的判据是**控件自己知道该多宽**：
 *  - `auto`（默认）—— 用控件的固有宽度。`Switch` / `Select` / `Button` / `NumberInput` 都属此档。
 *    只有 `input` / `textarea` / `text-select` 这类没有固有宽度的**直接子元素**回落到 `md`。
 *  - `sm` / `md` / `lg` —— 显式定宽，用于需要跨行对齐、或值本身很长（路径、URL）的输入。
 *  - `block` —— 控件掉到标题下方整宽。长文本 textarea 的正解是换行，不是把右槽加宽。
 *
 * **同一张卡里的输入类控件要用同一档。** 控件右边缘本来就是对齐的，但左边缘随宽度变——
 * 一张卡里混着 264px 和 420px，读起来就是一列参差不齐的框。哪一档由卡里**最长的那个值**
 * 决定（有 URL 就整卡 `lg`），不是每行各挑各的。Switch / Button 这类固有宽度控件不参与，
 * 它们本来就该紧凑。
 */
export type SettingsControlWidth = 'auto' | 'sm' | 'md' | 'lg' | 'block'

export interface SettingsRowProps extends ComponentPropsWithoutRef<'div'> {
  title: string
  description?: string
  action?: ReactNode
  control?: SettingsControlWidth
}

export const SettingsRow = memo(({
  title,
  description,
  action,
  control = 'auto',
  className,
  children,
  ...props
}: SettingsRowProps): ReactElement => (
  <div
    data-slot="settings-row"
    data-control={control}
    className={cn('velar-settings-row', className)}
    {...props}
  >
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

/**
 * 状态标记 —— 设置页里一切「已授权 / 已就绪 / 部分加载 / 未签名来源」的唯一形状。
 *
 * 此前这些字全是同一个 `--muted-foreground` 小字，「已授权」和「拒载」看上去一模一样；
 * 状态是要被扫读的，不是正文。tone 是封闭枚举，直接映射既有 `--status-*` 令牌，不自造颜色。
 */
export type SettingsStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface SettingsStatusProps {
  tone?: SettingsStatusTone
  children: ReactNode
}

export const SettingsStatus = memo(({
  tone = 'neutral',
  children,
}: SettingsStatusProps): ReactElement => (
  <span data-slot="settings-status" data-tone={tone} className={'velar-settings-status'}>
    {children}
  </span>
))

SettingsStatus.displayName = 'SettingsStatus'
