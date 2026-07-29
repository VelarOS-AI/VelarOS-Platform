/**
 * 设置面板对话框外壳。
 *
 * 样式：`.velar-settings-panel-dialog-size-md` · 见 styles/components/。
 */
import { type ReactElement, type ReactNode } from 'react'
import { XIcon } from '@phosphor-icons/react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

import { useUiLocalization } from '@velaros-ai/ui/i18n/UiLocalizationProvider'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import { cn } from '../../lib/cn'

const Dialog = DialogPrimitive.Root
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

export interface SettingsPanelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** 紧随标题展示的附加内容，例如状态标签。 */
  titleAddon?: ReactNode
  description?: ReactNode
  /**
   * 柔和样式：页眉、正文、页脚使用无边框浅底分区。
   * 标准样式：各外壳区域之间使用细分隔线。
   */
  chroming?: 'standard' | 'soft'
  /** 默认 `md`；宽表单应显式使用 `lg`、`xl` 或 `wide`。 */
  size?: 'md' | 'lg' | 'xl' | 'wide' | 'viewport60'
  children: ReactNode
  footer?: ReactNode
  className?: string
  bodyClassName?: string
  showClose?: boolean
}

const sizeClass: Record<NonNullable<SettingsPanelDialogProps['size']>, string> = {
  md: 'velar-settings-panel-dialog-size-md',
  lg: 'velar-settings-panel-dialog-size-lg',
  xl: 'velar-settings-panel-dialog-size-xl',
  wide: 'velar-settings-panel-dialog-size-wide',
  viewport60: 'velar-settings-panel-dialog-size-viewport60',
}

export function SettingsPanelDialog({
  open,
  onOpenChange,
  title,
  titleAddon,
  description,
  chroming = 'standard',
  size = 'md',
  children,
  footer,
  className,
  bodyClassName,
  showClose = true,
}: SettingsPanelDialogProps): ReactElement {
  const hasDescription = !!description
  const localization = useUiLocalization()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogPrimitive.Overlay
          data-slot="settings-panel-dialog-overlay"
          className="velar-dialog-overlay"
        />
        <DialogPrimitive.Content
          {...(hasDescription ? {} : { 'aria-describedby': undefined })}
          data-slot="settings-panel-dialog"
          className={cn(
            'velar-settings-panel-dialog-shell',
            sizeClass[size],
            chroming === 'soft' && 'velar-settings-panel-dialog-chroming-soft',
            className
          )}
        >
          <div className={'velar-settings-panel-dialog-header'}>
            <div className={'velar-settings-panel-dialog-title-row'}>
              <div className={'velar-settings-panel-dialog-title-cluster'}>
                <DialogPrimitive.Title className={'velar-settings-panel-dialog-title'}>
                  {title}
                </DialogPrimitive.Title>
                {!!titleAddon && (
                  <div className={'velar-settings-panel-dialog-title-addon'}>{titleAddon}</div>
                )}
              </div>
            </div>
            {hasDescription && (
              <DialogPrimitive.Description className={'velar-settings-panel-dialog-description'}>
                {description}
              </DialogPrimitive.Description>
            )}
          </div>

          <div className={cn('velar-settings-panel-dialog-body', bodyClassName)}>{children}</div>

          {!!footer && (
            <div className={'velar-settings-panel-dialog-footer'}>
              <div className={'velar-settings-panel-dialog-footer-inner'}>{footer}</div>
            </div>
          )}

          {showClose && (
            <DialogClose asChild>
              <IconButton
                label={localization.closeDialog}
                size="icon-sm"
                className={'velar-settings-panel-dialog-close-button'}
              >
                <XIcon size={16} />
              </IconButton>
            </DialogClose>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

SettingsPanelDialog.displayName = 'SettingsPanelDialog'
