import { type ReactElement, useState } from 'react'
import { useI18n } from '@catalog/i18n'
import { CaretRightIcon, DotsThreeIcon } from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { AnchoredPopover } from '@velaros-ai/ui/primitives/overlays/AnchoredPopover'
import { CascadingMenu } from '@velaros-ai/ui/primitives/overlays/CascadingMenu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,DialogTrigger } from '@velaros-ai/ui/primitives/overlays/Dialog'
import { ImagePreviewDialog } from '@velaros-ai/ui/primitives/overlays/ImagePreviewDialog'
import { Popover, PopoverAnchor, PopoverContent } from '@velaros-ai/ui/primitives/overlays/Popover'
import { SettingsPanelDialog } from '@velaros-ai/ui/primitives/overlays/SettingsPanelDialog'
import { Tooltip,TooltipContent, TooltipProvider, TooltipTrigger } from '@velaros-ai/ui/primitives/overlays/Tooltip'

const PreviewImageSrc =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" rx="18" fill="%23f6f8fb"/><rect x="28" y="28" width="264" height="144" rx="12" fill="%23ffffff" stroke="%23dfe5ef"/><circle cx="76" cy="82" r="22" fill="%231677ff" opacity="0.18"/><path d="M56 142l58-50 42 36 28-24 80 38H56z" fill="%231677ff" opacity="0.22"/><text x="56" y="62" font-family="Arial" font-size="16" fill="%231f2937">Image Preview</text></svg>'

function DialogExample(): ReactElement {
  const { t } = useI18n()

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {t('componentLibrary.exampleOverlayOpenDialog')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('componentLibrary.exampleOverlaySaveSettingsTitle')}</DialogTitle>
          <DialogDescription>
            {t('componentLibrary.exampleOverlayDialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="outline">
            {t('common.cancel')}
          </Button>
          <Button size="sm">{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PopoverExample(): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
          {t('componentLibrary.exampleOverlayOpenPopover')}
        </Button>
      </PopoverAnchor>
      <PopoverContent widthStrategy="adaptive">
        <Stack gap="xs">
          <strong>{t('componentLibrary.exampleOverlayWorkspace')}</strong>
          <span>{t('componentLibrary.exampleOverlayPopoverDescription')}</span>
        </Stack>
      </PopoverContent>
    </Popover>
  )
}

function TooltipExample(): ReactElement {
  const { t } = useI18n()

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost">
            {t('componentLibrary.exampleOverlayTooltipTrigger')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('componentLibrary.exampleOverlayTooltipContent')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function CascadingMenuExample(): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [submenuId, setSubmenuId] = useState<Nullable<string>>(null)

  return (
    <CascadingMenu
      open={open}
      onOpenChange={setOpen}
      activeSubmenuId={submenuId}
      onActiveSubmenuChange={setSubmenuId}
      anchor={({ getAnchorProps }) => (
        <Button {...getAnchorProps<HTMLButtonElement>()} size="sm" variant="outline">
          <DotsThreeIcon size={16} weight="bold" />
          {t('componentLibrary.exampleOverlayMore')}
        </Button>
      )}
    >
      {(menu) => (
        <>
          <div {...menu.getPrimaryPanelProps()}>
            <Button
              variant="ghost"
              size="block"
              {...menu.getSubmenuTriggerProps<HTMLButtonElement>('workspace', {
                className: menu.classes.item,
              })}
            >
              <span className={menu.classes.itemLabel}>
                {t('componentLibrary.exampleOverlayWorkspace')}
              </span>
              <CaretRightIcon size={12} className={menu.classes.disclosure} />
            </Button>
            <Button
              variant="ghost"
              size="block"
              {...menu.getLeafItemProps<HTMLButtonElement>({
                className: menu.classes.item,
              })}
            >
              <span className={menu.classes.itemLabel}>
                {t('componentLibrary.exampleOverlayRefresh')}
              </span>
            </Button>
          </div>
          {submenuId === 'workspace' && (
            <div {...menu.getSubmenuPanelProps()}>
              <Button variant="ghost" size="block" className={menu.classes.item}>
                <span className={menu.classes.itemLabel}>VelarOS-Desktop</span>
              </Button>
            </div>
          )}
        </>
      )}
    </CascadingMenu>
  )
}

function AnchoredPopoverExample(): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={setOpen}
      widthStrategy="anchor"
      anchor={({ getAnchorProps }) => (
        <Button {...getAnchorProps<HTMLButtonElement>()} size="sm" variant="outline">
          {t('componentLibrary.exampleOverlayAnchoredPopover')}
        </Button>
      )}
    >
      <Panel variant="inset">{t('componentLibrary.exampleOverlayAnchoredPopoverContent')}</Panel>
    </AnchoredPopover>
  )
}

function ImagePreviewExample(): ReactElement {
  const { t } = useI18n()
  const [openIndex, setOpenIndex] = useState<Nullable<number>>(null)

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpenIndex(0)}>
        {t('componentLibrary.exampleOverlayImagePreview')}
      </Button>
      <ImagePreviewDialog
        openIndex={openIndex}
        onOpenIndexChange={setOpenIndex}
        items={[
          {
            id: 'preview',
            src: PreviewImageSrc,
            alt: t('componentLibrary.exampleOverlayImageFixture'),
            title: t('componentLibrary.exampleOverlayImageFixture'),
            description: t('componentLibrary.exampleOverlayImageDescription'),
          },
        ]}
      />
    </>
  )
}

function SettingsPanelDialogExample(): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t('componentLibrary.exampleOverlaySettingsDialog')}
      </Button>
      <SettingsPanelDialog
        open={open}
        onOpenChange={setOpen}
        title={t('componentLibrary.exampleOverlayEditMemory')}
        description={t('componentLibrary.exampleOverlaySettingsDescription')}
        chroming="soft"
        size="md"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Panel variant="inset">{t('componentLibrary.exampleOverlayFormPlaceholder')}</Panel>
      </SettingsPanelDialog>
    </>
  )
}

export function OverlayExample(): ReactElement {
  return (
    <Inline gap="sm" wrap="wrap">
      <DialogExample />
      <PopoverExample />
      <TooltipExample />
      <CascadingMenuExample />
      <AnchoredPopoverExample />
      <ImagePreviewExample />
      <SettingsPanelDialogExample />
    </Inline>
  )
}
