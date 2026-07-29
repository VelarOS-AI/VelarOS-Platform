import { type ReactElement, useState } from 'react'
import { useI18n } from '@catalog/i18n'
import {
  ChoiceControlsInteractiveDemo,
  choiceControlsInteractiveDemoCode,
} from '@catalog/interactive-demos'
import { ListChecksIcon } from '@phosphor-icons/react'

import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { Label } from '@velaros-ai/ui/primitives/display/Label'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { CalendarDatePicker } from '@velaros-ai/ui/primitives/forms/Calendar'
import { Checkbox } from '@velaros-ai/ui/primitives/forms/Checkbox'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { NumberInput } from '@velaros-ai/ui/primitives/forms/NumberInput'
import { Picker } from '@velaros-ai/ui/primitives/forms/Picker'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { TextSelect } from '@velaros-ai/ui/primitives/forms/TextSelect'
import { TimePicker } from '@velaros-ai/ui/primitives/forms/TimePicker'
import { Flex } from '@velaros-ai/ui/primitives/layout/Flex'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { SettingsCard, SettingsRow } from '@velaros-ai/ui/product/layout/Settings'

function CategorySelectFieldPreview(): ReactElement {
  const [kind, setKind] = useState<'note' | 'fact'>('note')
  const { t } = useI18n()

  return (
    <Stack gap="xs" className="max-w-[400px]">
      <Text tone="caption">{t('componentLibrary.dataTableExample.colKind')}</Text>
      <Select
        size="sm"
        value={kind}
        options={[
          { value: 'note', label: t('componentLibrary.exampleFormKindNote') },
          { value: 'fact', label: t('componentLibrary.exampleFormKindFact') },
        ]}
        onChange={(value) => setKind(value)}
      />
    </Stack>
  )
}

function NotesTextareaPreview(): ReactElement {
  const { t } = useI18n()

  return (
    <Textarea
      rows={3}
      size="sm"
      aria-label={t('componentLibrary.formExample.notesAria')}
      defaultValue={t('componentLibrary.formExample.notesDefault')}
    />
  )
}

function PermissionSwitchRowPreview(): ReactElement {
  const [checked, setChecked] = useState(true)
  const { t } = useI18n()

  return (
    <SettingsCard>
      <SettingsRow
        title={t('componentLibrary.exampleFormPermissionTitle')}
        description={t('componentLibrary.exampleFormPermissionDescription')}
      >
        <Switch checked={checked} size="sm" onCheckedChange={setChecked} />
      </SettingsRow>
    </SettingsCard>
  )
}

function ThinkingDepthSegmentPreview(): ReactElement {
  const [strategy, setStrategy] = useState<'cost' | 'speed'>('cost')
  const { t } = useI18n()

  return (
    <SettingsCard>
      <Inline justify="between" align="center" gap="md" wrap="wrap">
        <Text>{t('componentLibrary.exampleFormTeamRouting')}</Text>
        <SegmentedControl
          value={strategy}
          options={[
            { value: 'cost', label: 'Cost' },
            { value: 'speed', label: 'Speed' },
          ]}
          onChange={(value) => setStrategy(value)}
        />
      </Inline>
    </SettingsCard>
  )
}

function ToolCatalogCheckboxRowPreview(): ReactElement {
  const [enabled, setEnabled] = useState(true)
  const { t } = useI18n()

  return (
    <Flex justify="between" align="start" gap="md">
      <Stack gap="xs">
        <Title level={5}>{t('componentLibrary.exampleFormFilesystemRead')}</Title>
        <Paragraph tone="secondary" spacing="none">
          {t('componentLibrary.exampleFormToolDensityDescription')}
        </Paragraph>
      </Stack>
      <Checkbox
        checked={enabled}
        size="sm"
        onCheckedChange={setEnabled}
        aria-label={t('componentLibrary.exampleFormEnableTool')}
      />
    </Flex>
  )
}

function SettingsSearchInputPreview(): ReactElement {
  const { t } = useI18n()

  return (
    <Input
      size="sm"
      placeholder={t('componentLibrary.searchPlaceholder')}
      aria-label={t('componentLibrary.searchAriaLabel')}
      defaultValue=""
    />
  )
}

function ScheduledTaskDatePickerPreview(): ReactElement {
  const [dateValue, setDateValue] = useState<Nullable<string>>('2026-07-03')
  const [timeValue, setTimeValue] = useState('09:00')

  return (
    <Stack gap="xs" className="max-w-[320px]">
      <Text tone="caption">Scheduled task anchor</Text>
      <Inline gap="xs" className="grid grid-cols-[minmax(0,1fr)_112px]">
        <CalendarDatePicker value={dateValue} onChange={setDateValue} />
        <TimePicker
          value={timeValue}
          disabled={!dateValue}
          aria-label="Scheduled task time"
          onChange={setTimeValue}
        />
      </Inline>
    </Stack>
  )
}

export function ChoiceGeneralComposerMenuSwitchPreview(): ReactElement {
  const [plan, setPlan] = useState(true)
  const { t } = useI18n()

  return (
    <Panel variant="inset" className="max-w-[320px]">
      <Flex align="center" gap="sm">
        <ListChecksIcon size={14} />
        <Text className="min-w-0 flex-1">{t('componentLibrary.formExample.planModeCaption')}</Text>
        <Switch size="sm" tone="neutral" checked={plan} onCheckedChange={setPlan} />
      </Flex>
    </Panel>
  )
}

export function InputExtensionExamples(): ReactElement {
  const [count, setCount] = useState(3)
  const [editor, setEditor] = useState('vscode')
  const [model, setModel] = useState('gpt-5.4')
  const { t } = useI18n()

  return (
    <Stack gap="sm">
      <Inline gap="sm" wrap="wrap">
        <Label htmlFor="library-number-input">{t('componentLibrary.formExample.stepsLabel')}</Label>
        <NumberInput
          id="library-number-input"
          size="sm"
          value={count}
          min={1}
          max={10}
          onChange={setCount}
        />
        <Picker
          value={editor}
          title={t('componentLibrary.formExample.defaultEditorTitle')}
          icon={<FileTypeIcon fileName="app.tsx" size={14} />}
          options={[
            { value: 'vscode', label: 'Visual Studio Code' },
            { value: 'cursor', label: 'Cursor' },
            { value: 'zed', label: 'Zed' },
          ]}
          onChange={setEditor}
        />
        <TextSelect
          className="w-[220px]"
          label={t('chat.selectModel')}
          value={model}
          options={[
            { value: 'gpt-5.4', label: 'GPT-5.4' },
            { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
            { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
          ]}
          loading={false}
          onChange={setModel}
          onCommit={(nextValue) => setModel(nextValue ?? '')}
        />
      </Inline>
      <Inline gap="sm" wrap="wrap">
        <FileTypeIcon fileName="brief.docx" size={18} />
        <FileTypeIcon fileName="preview.png" size={18} />
        <FileTypeIcon fileName="app.tsx" size={18} />
      </Inline>
    </Stack>
  )
}

export const fieldRecommendations = [
  {
    id: 'compact-filter',
    title: 'Popover filter field',
    description:
      'Settings search popovers use an Input size="sm" with a localized placeholder.',
    preview: <SettingsSearchInputPreview />,
    code: `// Generic settings search popover
<Input
  size="sm"
  className={styles.searchInput}
  value={query}
  placeholder={t('componentLibrary.searchPlaceholder')}
  onChange={(event) => onQueryChange(event.target.value)}
  aria-label={t('componentLibrary.searchAriaLabel')}
/>`,
  },
  {
    id: 'select-with-description',
    title: 'Form grid select',
    description:
      'Use Select size="sm" bound to draft state with localized option labels.',
    preview: <CategorySelectFieldPreview />,
    code: `// Generic settings form select
<Select
  size="sm"
  value={draft.kind}
  options={draftKindOptions}
  onChange={(value) => onDraftChange({ kind: value })}
/>`,
  },
  {
    id: 'textarea-notes',
    title: '长文本字段',
    description: 'Textarea 使用 size="sm"，承载多行用户输入。',
    preview: <NotesTextareaPreview />,
    code: `// Generic settings notes field
<Textarea
  rows={4}
  value={draft.summary}
  onChange={(event) => onDraftChange({ summary: event.target.value })}
/>`,
  },
  {
    id: 'calendar-date-picker',
    title: 'Scheduled task date anchor',
    description:
      'Use CalendarDatePicker for the date anchor and TimePicker for the timestamp time; keep them as two controls inside the same form field.',
    preview: <ScheduledTaskDatePickerPreview />,
    code: `// features/tasks/components/ScheduleDraftFields.tsx
<div className={styles.scheduleDateTimePair}>
  <CalendarDatePicker
    value={dateValue}
    onChange={(nextDate) => updateTimestamp(nextDate, timeValue)}
  />
  <TimePicker
    value={timeValue}
    onChange={(nextTime) => updateTimestamp(dateValue, nextTime)}
  />
</div>`,
  },
  {
    id: 'settings-memory-and-model-forms',
    title: '设置页：模型 / 系统表单串联',
    description:
      'ModelSelectionControl、ModelProviderConfigCard、ModelSettingsStatusBlock、DefaultEditorSelectRow、SystemPromptAppendField 等在同一段设置密度下复用本节登记的 Input / Select / Textarea / SettingsRow。',
    code: `// 详见 components/business/model 下的设置实现。`,
  },
]

export const choiceRecommendations = [
  {
    id: 'quiet-switch',
    title: 'Permission row switch',
    description:
      '与 PermissionToggleCard 一致：SettingsRow + Switch size="sm"，成组设置场景不覆写 tone。',
    preview: <PermissionSwitchRowPreview />,
    code: `// components/business/system/PermissionToggleCard.tsx
<SettingsRow title={item.title} description={item.description}>
  <Switch checked={item.checked} disabled={item.disabled} size="sm" onCheckedChange={item.onChange} />
</SettingsRow>`,
  },
  {
    id: 'segmented-local-mode',
    title: '设置卡片内的策略切换',
    description:
      '设置卡片模式：标题旁放 SegmentedControl 做策略切换，搭配紧凑排版；不要当成应用级导航。',
    preview: <ThinkingDepthSegmentPreview />,
    code: `// 设置卡片头部的策略切换 SegmentedControl
<SegmentedControl
  value={strategy}
  options={strategyOptions}
  onChange={onStrategyChange}
/>`,
  },
  {
    id: 'tool-catalog-checkbox',
    title: 'Tool row checkbox',
    description: '与 ToolCatalogPanel 一致：密集工具行末尾放 Checkbox size="sm"，与堆叠文案对齐。',
    preview: <ToolCatalogCheckboxRowPreview />,
    code: `// components/business/tool/ToolCatalogPanel.tsx
<Checkbox
  className={styles.toolCheckbox}
  checked={tool.enabled}
  size="sm"
  disabled={tool.disabled}
  onCheckedChange={tool.onEnabledChange}
/>`,
  },
]

export { ChoiceControlsInteractiveDemo, choiceControlsInteractiveDemoCode }
