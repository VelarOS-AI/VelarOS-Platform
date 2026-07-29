import { type ReactElement, useState } from 'react'
import { useI18n } from '@catalog/i18n'
import {
  BadgePanelInteractiveDemo,
  badgePanelInteractiveDemoCode,
} from '@catalog/interactive-demos'
import { CheckIcon, EyeIcon, TrashIcon } from '@phosphor-icons/react'

import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Progress } from '@velaros-ai/ui/primitives/display/Progress'
import { Result } from '@velaros-ai/ui/primitives/display/Result'
import { Skeleton } from '@velaros-ai/ui/primitives/display/Skeleton'
import { Spin } from '@velaros-ai/ui/primitives/display/Spin'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { ActionCard, ActionCardIconButton } from '@velaros-ai/ui/product/layout/ActionCard'
import { SettingsCard, SettingsRow, SettingsSection } from '@velaros-ai/ui/product/layout/Settings'

function OperationResultActionCardPreview(): ReactElement {
  const { t } = useI18n()

  return (
    <ActionCard
      tone="success"
      icon={<CheckIcon size={17} weight="bold" />}
      title={t('common.saved')}
      description={t('componentLibrary.feedbackExample.insetText')}
      actions={
        <>
          <ActionCardIconButton label={t('common.open')}>
            <EyeIcon size={15} />
          </ActionCardIconButton>
          <ActionCardIconButton label={t('common.delete')}>
            <TrashIcon size={15} />
          </ActionCardIconButton>
        </>
      }
    />
  )
}

export function BadgeExamples(): ReactElement {
  const { t } = useI18n()

  return (
    <Inline gap="sm" wrap="wrap">
      <Badge>{t('componentLibrary.feedbackExample.badgeReady')}</Badge>
      <Badge variant="secondary">{t('componentLibrary.feedbackExample.badgeDraft')}</Badge>
      <Badge variant="outline">{t('componentLibrary.feedbackExample.badgePreview')}</Badge>
      <Badge variant="destructive">{t('componentLibrary.feedbackExample.badgeBlocked')}</Badge>
    </Inline>
  )
}

export function PanelExamples(): ReactElement {
  const { t } = useI18n()

  return (
    <Stack gap="sm">
      <Panel variant="strong">
        <Stack gap="xs">
          <Title level={5}>{t('componentLibrary.feedbackExample.strongTitle')}</Title>
          <Text>{t('componentLibrary.feedbackExample.strongText')}</Text>
        </Stack>
      </Panel>
      <Panel variant="inset">
        <Inline gap="sm" wrap="wrap">
          <CheckIcon size={15} />
          <Text>{t('componentLibrary.feedbackExample.insetText')}</Text>
        </Inline>
      </Panel>
    </Stack>
  )
}

export function SettingsLayoutExamples(): ReactElement {
  const [enabled, setEnabled] = useState(true)
  const { t } = useI18n()

  return (
    <SettingsSection
      title={t('componentLibrary.feedbackExample.settingsSectionTitle')}
      description={t('componentLibrary.feedbackExample.settingsSectionDescription')}
    >
      <SettingsCard>
        <SettingsRow
          title={t('componentLibrary.feedbackExample.autoSaveTitle')}
          description={t('componentLibrary.feedbackExample.autoSaveDescription')}
        >
          <Switch size="sm" tone="neutral" checked={enabled} onCheckedChange={setEnabled} />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}

export function StatusFeedbackExamples(): ReactElement {
  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Title level={5}>Progress</Title>
        <Progress value={64} />
        <Progress value={40} tone="success" size="sm" />
        <Progress value={72} tone="warning" />
        <Progress value={88} tone="error" />
        <Progress indeterminate tone="neutral" />
      </Stack>
      <Stack gap="sm">
        <Title level={5}>Spin</Title>
        <Inline gap="md" align="center">
          <Spin spinning size="sm" />
          <Spin spinning size="md" />
          <Spin spinning tip="Loading…" />
        </Inline>
      </Stack>
      <Stack gap="sm">
        <Title level={5}>Skeleton</Title>
        <Skeleton variant="textLg" />
        <Skeleton variant="text" />
        <Skeleton variant="textSm" width={180} />
        <Inline gap="md" align="center">
          <Skeleton variant="circular" width={40} height={40} />
          <Skeleton variant="rounded" width={120} height={40} />
          <Skeleton variant="rectangular" width={120} height={40} />
        </Inline>
      </Stack>
      <Stack gap="md">
        <Title level={5}>Result</Title>
        <Result tone="success" title="Saved" subTitle="All changes committed." />
        <Result tone="info" title="Nothing to review" subTitle="The working tree is clean." />
        <Result tone="warning" title="Needs attention" subTitle="2 files skipped." />
        <Result tone="error" title="Build failed" subTitle="See the log for details." />
      </Stack>
    </Stack>
  )
}

export const feedbackRecommendations = [
  {
    id: 'action-card',
    title: 'Chat operation result card',
    description:
      'Use a semantic tone, compact title/description, and icon-only actions with accessible labels.',
    preview: <OperationResultActionCardPreview />,
    code: `// Generic chat operation feedback
<ActionCard
  tone="success"
  icon={<CheckIcon size={17} weight="bold" />}
  title={t('common.saved')}
  description={detail}
  actions={...}
/>`,
  },
]

export { BadgePanelInteractiveDemo, badgePanelInteractiveDemoCode }
