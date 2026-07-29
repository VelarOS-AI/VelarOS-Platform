import { type ReactElement, useState } from 'react'
import { useI18n } from '@catalog/i18n'

import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { SettingsCard, SettingsRow } from '@velaros-ai/ui/product/layout/Settings'

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'
type PanelVariant = 'default' | 'muted' | 'strong' | 'inset'

const badgeVariantOptions: Array<{ value: BadgeVariant; label: string }> = [
  { value: 'default', label: 'default' },
  { value: 'secondary', label: 'secondary' },
  { value: 'outline', label: 'outline' },
  { value: 'destructive', label: 'destructive' },
]

const panelVariantOptions: Array<{ value: PanelVariant; label: string }> = [
  { value: 'default', label: 'default' },
  { value: 'muted', label: 'muted' },
  { value: 'strong', label: 'strong' },
  { value: 'inset', label: 'inset' },
]

export const badgePanelInteractiveDemoCode = `
// Badge + Panel: drive variant props from local state (same pattern as settings cards).
`.trim()

export function BadgePanelInteractiveDemo(): ReactElement {
  const { t } = useI18n()
  const [badgeVariant, setBadgeVariant] = useState<BadgeVariant>('default')
  const [panelVariant, setPanelVariant] = useState<PanelVariant>('inset')
  const [showDot, setShowDot] = useState(false)

  return (
    <Stack gap="md">
      <SettingsCard>
        <SettingsRow
          title="Badge.variant"
          description={t('componentLibrary.badgePanelInteractiveDemo.variantDescription')}
        >
          <SegmentedControl
            value={badgeVariant}
            options={badgeVariantOptions}
            onChange={(v) => setBadgeVariant(v)}
          />
        </SettingsRow>
        <SettingsRow
          title="Panel.variant"
          description={t('componentLibrary.badgePanelInteractiveDemo.panelDescription')}
        >
          <SegmentedControl
            value={panelVariant}
            options={panelVariantOptions}
            onChange={(v) => setPanelVariant(v)}
          />
        </SettingsRow>
        <SettingsRow
          title={t('componentLibrary.badgePanelInteractiveDemo.innerLayoutTitle')}
          description={t('componentLibrary.badgePanelInteractiveDemo.innerLayoutDescription')}
        >
          <Switch size="sm" tone="neutral" checked={showDot} onCheckedChange={setShowDot} />
        </SettingsRow>
      </SettingsCard>
      <Panel variant={panelVariant}>
        {showDot ? (
          <Inline gap="sm" align="center" wrap="wrap">
            <Badge variant={badgeVariant}>{t('componentLibrary.badgePanelInteractiveDemo.ready')}</Badge>
            <Text tone="secondary">{t('componentLibrary.badgePanelInteractiveDemo.secondaryCaption')}</Text>
          </Inline>
        ) : (
          <Stack gap="xs">
            <Badge variant={badgeVariant}>{t('componentLibrary.badgePanelInteractiveDemo.ready')}</Badge>
            <Paragraph tone="secondary" spacing="none">
              {t('componentLibrary.badgePanelInteractiveDemo.stackedLayout')}
            </Paragraph>
          </Stack>
        )}
      </Panel>
    </Stack>
  )
}
