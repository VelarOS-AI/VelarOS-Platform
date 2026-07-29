import { type ReactElement, useState } from 'react'
import { useI18n } from '@catalog/i18n'
import { GearIcon } from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { SettingsCard, SettingsRow } from '@velaros-ai/ui/product/layout/Settings'

type ButtonVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link'
type ButtonSize = 'sm' | 'default' | 'lg'
type IconInteractiveDemoSize = 'icon-sm' | 'icon' | 'custom-16'

const buttonVariantOptions: Array<{ value: ButtonVariant; label: string }> = [
  { value: 'default', label: 'default' },
  { value: 'outline', label: 'outline' },
  { value: 'secondary', label: 'secondary' },
  { value: 'ghost', label: 'ghost' },
  { value: 'destructive', label: 'destructive' },
  { value: 'link', label: 'link' },
]

const buttonSizeOptions: Array<{ value: ButtonSize; label: string }> = [
  { value: 'sm', label: 'sm' },
  { value: 'default', label: 'md' },
  { value: 'lg', label: 'lg' },
]

const iconVariantOptions: Array<{ value: 'ghost' | 'outline'; label: string }> = [
  { value: 'ghost', label: 'ghost' },
  { value: 'outline', label: 'outline' },
]

const iconSizeOptions: Array<{ value: IconInteractiveDemoSize; label: string }> = [
  { value: 'icon-sm', label: 'icon-sm' },
  { value: 'icon', label: 'icon' },
  { value: 'custom-16', label: '16px' },
]

export const buttonIconInteractiveDemoCode = `
import { useState } from 'react'
import { GearIcon } from '@phosphor-icons/react'

export function ButtonIconInteractiveDemo() {
  const [variant, setVariant] = useState<'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link'>('default')
  const [size, setSize] = useState<'sm' | 'default' | 'lg'>('sm')
  const [disabled, setDisabled] = useState(false)
  const [iconVariant, setIconVariant] = useState<'ghost' | 'outline'>('ghost')
  const [iconSize, setIconSize] = useState<'icon-sm' | 'icon' | 'custom-16'>('icon-sm')

  return (
    <Stack gap="md">
      <SettingsCard>
        <SettingsRow title="Button.variant" description="Maps to Button variant prop">
          <SegmentedControl value={variant} options={[...]} onChange={(v) => setVariant(v as typeof variant)} />
        </SettingsRow>
        <SettingsRow title="Button.size" description="sm | default | lg">
          <SegmentedControl value={size} options={[...]} onChange={(v) => setSize(v as typeof size)} />
        </SettingsRow>
        <SettingsRow title="disabled">
          <Switch checked={disabled} onCheckedChange={setDisabled} size="sm" tone="neutral" />
        </SettingsRow>
        <SettingsRow title="IconButton.variant">
          <SegmentedControl value={iconVariant} options={[...]} onChange={...} />
        </SettingsRow>
        <SettingsRow title="IconButton.size">
          <SegmentedControl value={iconSize} options={[...]} onChange={...} />
        </SettingsRow>
      </SettingsCard>
      <Panel variant="inset">
        <Inline gap="sm" wrap="wrap" align="center">
          <Button variant={variant} size={size} disabled={disabled}>
            Save
          </Button>
          <IconButton label="Settings" variant={iconVariant} size={iconSize === 'custom-16' ? 16 : iconSize} disabled={disabled}>
            <GearIcon size={18} />
          </IconButton>
        </Inline>
      </Panel>
    </Stack>
  )
}
`.trim()

export function ButtonIconInteractiveDemo(): ReactElement {
  const { t } = useI18n()
  const [variant, setVariant] = useState<ButtonVariant>('default')
  const [size, setSize] = useState<ButtonSize>('sm')
  const [disabled, setDisabled] = useState(false)
  const [iconVariant, setIconVariant] = useState<'ghost' | 'outline'>('ghost')
  const [iconSize, setIconSize] = useState<IconInteractiveDemoSize>('icon-sm')

  const buttonSizeProp = size === 'default' ? 'default' : size
  const iconSizeProp = iconSize === 'custom-16' ? 16 : iconSize

  return (
    <Stack gap="md">
      <SettingsCard>
        <SettingsRow
          title={t('componentLibrary.buttonIconInteractiveDemo.variantTitle')}
          description={t('componentLibrary.buttonIconInteractiveDemo.variantDescription')}
        >
          <SegmentedControl
            value={variant}
            options={buttonVariantOptions}
            onChange={(v) => setVariant(v)}
          />
        </SettingsRow>
        <SettingsRow
          title={t('componentLibrary.buttonIconInteractiveDemo.sizeTitle')}
          description={t('componentLibrary.buttonIconInteractiveDemo.sizeDescription')}
        >
          <SegmentedControl value={size} options={buttonSizeOptions} onChange={(v) => setSize(v)} />
        </SettingsRow>
        <SettingsRow
          title={t('componentLibrary.buttonIconInteractiveDemo.disabledTitle')}
          description={t('componentLibrary.buttonIconInteractiveDemo.disabledDescription')}
        >
          <Switch size="sm" tone="neutral" checked={disabled} onCheckedChange={setDisabled} />
        </SettingsRow>
        <SettingsRow
          title="IconButton.variant"
          description={t('componentLibrary.buttonIconInteractiveDemo.toolbarHint')}
        >
          <SegmentedControl
            value={iconVariant}
            options={iconVariantOptions}
            onChange={(v) => setIconVariant(v)}
          />
        </SettingsRow>
        <SettingsRow title="IconButton.size" description="icon-sm · icon · 16px">
          <SegmentedControl
            value={iconSize}
            options={iconSizeOptions}
            onChange={(v) => setIconSize(v)}
          />
        </SettingsRow>
      </SettingsCard>
      <Panel variant="inset">
        <Inline gap="sm" wrap="wrap" align="center">
          <Button variant={variant} size={buttonSizeProp} disabled={disabled}>
            {t('componentLibrary.buttonIconInteractiveDemo.save')}
          </Button>
          <IconButton
            label={t('componentLibrary.buttonIconInteractiveDemo.settings')}
            variant={iconVariant}
            size={iconSizeProp}
            disabled={disabled}
          >
            <GearIcon size={18} />
          </IconButton>
        </Inline>
      </Panel>
    </Stack>
  )
}
