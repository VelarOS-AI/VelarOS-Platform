import { type ReactElement, useState } from 'react'
import {
  GhostIconSmPreview,
  TwoButtonDialogFooterPreview,
} from '@catalog/examples/FoundationExamplePresenters'
import { useI18n } from '@catalog/i18n'
import {
  ButtonIconInteractiveDemo,
  buttonIconInteractiveDemoCode,
} from '@catalog/interactive-demos'
import { MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { CopyButton } from '@velaros-ai/ui/product/buttons/CopyButton'
import { DeleteOutlineIconButton } from '@velaros-ai/ui/product/buttons/DeleteOutlineIconButton'

function SaveDialogFooterPreview(): ReactElement {
  const { t } = useI18n()
  return <TwoButtonDialogFooterPreview primaryLabel={t('common.save')} />
}

function DeleteDialogFooterPreview(): ReactElement {
  const { t } = useI18n()
  return (
    <TwoButtonDialogFooterPreview primaryLabel={t('common.delete')} primaryVariant="destructive" />
  )
}

function SearchSectionIconPreview(): ReactElement {
  const { t } = useI18n()
  return (
    <GhostIconSmPreview label={t('componentLibrary.exampleButtonSearchSection')}>
      <MagnifyingGlassIcon size={18} />
    </GhostIconSmPreview>
  )
}

function CreateSkillIconPreview(): ReactElement {
  const { t } = useI18n()
  return (
    <GhostIconSmPreview label={t('componentLibrary.exampleButtonCreateSkill')}>
      <PlusIcon size={18} />
    </GhostIconSmPreview>
  )
}

export function ButtonAuxiliaryExamples(): ReactElement {
  const [deleteBordered, setDeleteBordered] = useState(false)
  const { t } = useI18n()

  return (
    <Stack gap="sm">
      <Inline gap="sm" align="center" wrap="wrap">
        <CopyButton
          value="bun run scripts:run typecheck:web"
          label={t('componentLibrary.buttonAuxiliaryExample.copyLabel')}
          copiedLabel={t('componentLibrary.buttonAuxiliaryExample.copiedLabel')}
          variant="outline"
        />
        <DeleteOutlineIconButton
          label={t('componentLibrary.buttonAuxiliaryExample.deleteLabel')}
          bordered={deleteBordered}
          onClick={() => undefined}
        />
        <Switch
          size="sm"
          tone="neutral"
          checked={deleteBordered}
          onCheckedChange={setDeleteBordered}
          aria-label={t('componentLibrary.buttonAuxiliaryExample.deleteBorderedAria')}
        />
        <Text tone="caption">{t('componentLibrary.buttonAuxiliaryExample.borderedToggleHint')}</Text>
      </Inline>
    </Stack>
  )
}

const buttonRecommendations = [
  {
    id: 'primary-command',
    title: 'Settings dialog footer (save flow)',
    description:
      'Pair outline cancel with primary save, both size="sm", inside a SettingsPanelDialog footer.',
    preview: <SaveDialogFooterPreview />,
    code: `// Generic settings editor footer
<Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
  {t('common.cancel')}
</Button>
<Button size="sm" disabled={submitting} onClick={onSave}>
  {action}
</Button>`,
  },
  {
    id: 'secondary-command',
    title: 'Destructive confirmation footer',
    description:
      'Pair outline dismiss with destructive confirm using compact sm controls.',
    preview: <DeleteDialogFooterPreview />,
    code: `// Generic destructive confirmation footer
<Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
  {t('common.cancel')}
</Button>
<Button variant="destructive" size="sm" onClick={onConfirm}>
  {t('common.delete')}
</Button>`,
  },
]

const iconButtonRecommendations = [
  {
    id: 'toolbar-icon',
    title: 'Anchored search control (settings)',
    description:
      'Use ghost + icon-sm inside the AnchoredPopover anchor slot.',
    preview: <SearchSectionIconPreview />,
    code: `// Generic settings section search
<IconButton
  {...anchorProps}
  label={t('componentLibrary.searchAriaLabel')}
  variant="ghost"
  size="icon-sm"
  className={styles.searchIconBtn}
>
  <MagnifyingGlassIcon size={18} />
</IconButton>`,
  },
  {
    id: 'visible-boundary',
    title: 'Section title addon (skills)',
    description:
      'Same as SkillSettingsPanel title row: ghost icon-sm for create next to the section search popover.',
    preview: <CreateSkillIconPreview />,
    code: `// components/settings/sections/SkillSettingsPanel.tsx
<IconButton
  label={t('settings.skillCreate')}
  variant="ghost"
  size="icon-sm"
  className={styles.searchIconBtn}
  onClick={onCreate}
>
  <PlusIcon size={18} />
</IconButton>`,
  },
]

export const buttonAndIconRecommendations = [...buttonRecommendations, ...iconButtonRecommendations]

export { ButtonIconInteractiveDemo, buttonIconInteractiveDemoCode }
