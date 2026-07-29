import { type ReactElement, useState } from 'react'
import { useI18n } from '@catalog/i18n'

import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Checkbox } from '@velaros-ai/ui/primitives/forms/Checkbox'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { SettingsCard, SettingsRow } from '@velaros-ai/ui/product/layout/Settings'

const densityOptions = [
  { value: 'comfortable', label: 'comfortable' },
  { value: 'compact', label: 'compact' },
  { value: 'minimal', label: 'minimal' },
]

export const choiceControlsInteractiveDemoCode = `
// Switch + Checkbox + SegmentedControl — mirror PermissionToggleCard 与设置卡头策略切换的组合模式。
`.trim()

export function ChoiceControlsInteractiveDemo(): ReactElement {
  const { t } = useI18n()
  const [plan, setPlan] = useState(true)
  const [notify, setNotify] = useState(false)
  const [density, setDensity] = useState('compact')

  return (
    <Stack gap="md">
      <SettingsCard>
        <SettingsRow
          title={t('componentLibrary.choiceControlsInteractiveDemo.switchPlanTitle')}
          description={t('componentLibrary.choiceControlsInteractiveDemo.switchPlanDescription')}
        >
          <Switch size="sm" tone="neutral" checked={plan} onCheckedChange={setPlan} />
        </SettingsRow>
        <SettingsRow
          title={t('componentLibrary.choiceControlsInteractiveDemo.checkboxTitle')}
          description={t('componentLibrary.choiceControlsInteractiveDemo.checkboxDescription')}
        >
          <Checkbox
            size="sm"
            checked={notify}
            onCheckedChange={setNotify}
            aria-label={t('componentLibrary.choiceControlsInteractiveDemo.notifyAria')}
          />
        </SettingsRow>
        <SettingsRow
          title={t('componentLibrary.choiceControlsInteractiveDemo.segmentedTitle')}
          description={t('componentLibrary.choiceControlsInteractiveDemo.segmentedDescription')}
        >
          <SegmentedControl value={density} options={densityOptions} onChange={setDensity} />
        </SettingsRow>
      </SettingsCard>
      <Panel variant="inset">
        <Text tone="caption">
          {t('componentLibrary.choiceControlsInteractiveDemo.statePrefix')}
          plan={String(plan)} · notify={String(notify)} · density={density}
        </Text>
      </Panel>
    </Stack>
  )
}
