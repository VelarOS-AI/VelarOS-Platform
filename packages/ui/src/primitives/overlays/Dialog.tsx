/**
 * 模态对话框（基于 Radix Dialog）。
 *
 * 样式：`.velar-dialog-overlay` · 见 styles/components/。
 */
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  type ReactElement,
} from 'react'
import { XIcon } from '@phosphor-icons/react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

import { useUiLocalization } from '@velaros-ai/ui/i18n/UiLocalizationProvider'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import { cn } from '../../lib/cn'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(
  ({ className, ...props }, ref): ReactElement => (
    <DialogPrimitive.Overlay
      ref={ref}
      data-slot="dialog-overlay"
      className={cn('velar-dialog-overlay', className)}
      {...props}
    />
  )
)

DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

export interface DialogContentProps extends ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  showClose?: boolean
}

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, showClose = true, ...props }, ref): ReactElement => {
  const localization = useUiLocalization()

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        data-slot="dialog-content"
        className={cn('velar-dialog-content', className)}
        {...props}
      >
        {children}
        {showClose && (
          <DialogClose asChild>
            <IconButton
              label={localization.closeDialog}
              size="icon-sm"
              className="velar-dialog-close-button"
            >
              <XIcon size={16} />
            </IconButton>
          </DialogClose>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})

DialogContent.displayName = DialogPrimitive.Content.displayName

export const DialogHeader = ({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>): ReactElement => (
  <div data-slot="dialog-header" className={cn('velar-dialog-header', className)} {...props} />
)

export const DialogFooter = ({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>): ReactElement => (
  <div data-slot="dialog-footer" className={cn('velar-dialog-footer', className)} {...props} />
)

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(
  ({ className, ...props }, ref): ReactElement => (
    <DialogPrimitive.Title
      ref={ref}
      data-slot="dialog-title"
      className={cn('velar-dialog-title', className)}
      {...props}
    />
  )
)

DialogTitle.displayName = DialogPrimitive.Title.displayName

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(
  ({ className, ...props }, ref): ReactElement => (
    <DialogPrimitive.Description
      ref={ref}
      data-slot="dialog-description"
      className={cn('velar-dialog-description', className)}
      {...props}
    />
  )
)

DialogDescription.displayName = DialogPrimitive.Description.displayName

export { Dialog, DialogClose, DialogPortal, DialogTrigger }
