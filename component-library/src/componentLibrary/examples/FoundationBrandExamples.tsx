import { type ReactElement, useState } from 'react'
import { useI18n } from '@catalog/i18n'

import {
  VelarSailMark,
  type VelarSailMarkMotion,
  type VelarSailMarkSize,
} from '@velaros-ai/conversation-ui'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'
import { Center } from '@velaros-ai/ui/primitives/layout/Center'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { SettingsCard, SettingsRow } from '@velaros-ai/ui/product/layout/Settings'

const velarSailSizeOptions: Array<{ value: VelarSailMarkSize; label: string }> = [
  { value: 'tiny', label: 'tiny' },
  { value: 'small', label: 'small' },
  { value: 'large', label: 'large' },
  { value: 'splash', label: 'splash' },
]

const velarSailMotionOptions: Array<{ value: VelarSailMarkMotion; label: string }> = [
  { value: 'intro', label: 'intro' },
  { value: 'steady', label: 'steady' },
  { value: 'still', label: 'still' },
]

export const velarSailInteractiveDemoCode = `
import { useState } from 'react'
import {
  VelarSailMark,
  type VelarSailMarkMotion,
  type VelarSailMarkSize,
} from '@velaros-ai/conversation-ui'

export function VelarSailMarkInteractiveDemo() {
  const [size, setSize] = useState<VelarSailMarkSize>('small')
  const [motion, setMotion] = useState<VelarSailMarkMotion>('steady')
  const [animated, setAnimated] = useState(true)
  const [decorative, setDecorative] = useState(true)

  return (
    <Stack gap="md">
      <SettingsCard>
        <SettingsRow title="Size" description="tiny | small | large">
          <SegmentedControl
            value={size}
            options={[
              { value: 'tiny', label: 'tiny' },
              { value: 'small', label: 'small' },
              { value: 'large', label: 'large' },
              { value: 'splash', label: 'splash' },
            ]}
            onChange={(value) => setSize(value as VelarSailMarkSize)}
          />
        </SettingsRow>
        <SettingsRow title="Motion" description="Honoured when animated is true">
          <SegmentedControl
            value={motion}
            options={[
              { value: 'intro', label: 'intro' },
              { value: 'steady', label: 'steady' },
              { value: 'still', label: 'still' },
            ]}
            onChange={(value) => setMotion(value as VelarSailMarkMotion)}
          />
        </SettingsRow>
        <SettingsRow title="Animated" description="false forces still motion">
          <Switch size="sm" tone="neutral" checked={animated} onCheckedChange={setAnimated} />
        </SettingsRow>
        <SettingsRow title="Decorative" description="false exposes role=img + aria-label">
          <Switch size="sm" tone="neutral" checked={decorative} onCheckedChange={setDecorative} />
        </SettingsRow>
      </SettingsCard>
      <Panel variant="inset">
        <Center className="min-h-32 py-4">
          <VelarSailMark size={size} motion={motion} animated={animated} decorative={decorative} />
        </Center>
      </Panel>
    </Stack>
  )
}
`

export function VelarSailMarkInteractiveDemo(): ReactElement {
  const [size, setSize] = useState<VelarSailMarkSize>('small')
  const [motion, setMotion] = useState<VelarSailMarkMotion>('steady')
  const [animated, setAnimated] = useState(true)
  const [decorative, setDecorative] = useState(true)
  const { t } = useI18n()

  return (
    <Stack gap="md">
      <SettingsCard>
        <SettingsRow
          title={t('componentLibrary.brandExample.sizeTitle')}
          description={t('componentLibrary.brandExample.sizeDescription')}
        >
          <SegmentedControl
            value={size}
            options={velarSailSizeOptions}
            onChange={(value) => setSize(value)}
          />
        </SettingsRow>
        <SettingsRow
          title={t('componentLibrary.brandExample.motionTitle')}
          description={t('componentLibrary.brandExample.motionDescription')}
        >
          <SegmentedControl
            value={motion}
            options={velarSailMotionOptions}
            onChange={(value) => setMotion(value)}
          />
        </SettingsRow>
        <SettingsRow
          title={t('componentLibrary.brandExample.animatedTitle')}
          description={t('componentLibrary.brandExample.animatedDescription')}
        >
          <Switch size="sm" tone="neutral" checked={animated} onCheckedChange={setAnimated} />
        </SettingsRow>
        <SettingsRow
          title={t('componentLibrary.brandExample.decorativeTitle')}
          description={t('componentLibrary.brandExample.decorativeDescription')}
        >
          <Switch size="sm" tone="neutral" checked={decorative} onCheckedChange={setDecorative} />
        </SettingsRow>
      </SettingsCard>
      <Panel variant="inset">
        <Center className="min-h-32 py-4">
          <VelarSailMark size={size} motion={motion} animated={animated} decorative={decorative} />
        </Center>
      </Panel>
    </Stack>
  )
}

export const velarSailRecommendations = [
  {
    id: 'startup-intro',
    title: 'Startup splash (steady)',
    description:
      'StartupIntro places a larger steady mark inside appStartupSailScene so the splash icon stays visible without the intro fade loop.',
    preview: (
      <Center className="p-3">
        <VelarSailMark
          size="splash"
          motion="steady"
          windLineMotion="slide"
          animated
          decorative
        />
      </Center>
    ),
    code: `// RootRuntime.tsx — StartupIntro
<div className={className} aria-busy={!isReady}>
  <div className="appStartupSailScene">
    <VelarSailMark motion="steady" size="splash" windLineMotion="slide" />
  </div>
  {/* progress + wordmark follow */}
</div>`,
  },
  {
    id: 'sidebar-tiny',
    title: 'Collapsed sidebar mark',
    description:
      'SidebarHeader shows a tiny steady mark inside the ghost brand Button when the rail is collapsed.',
    preview: (
      <Center className="p-3">
        <VelarSailMark size="tiny" motion="steady" animated decorative />
      </Center>
    ),
    code: `// components/shell/sidebar/SidebarHeader.tsx
<Button variant="ghost" size={collapsed ? 'icon-sm' : 'sm'} className={cx('brandButton', collapsed && 'collapsed')} ...>
  {collapsed ? (
    <VelarSailMark className={styles.collapsedBrandMark} motion="steady" size="tiny" />
  ) : (
    <p className={styles.brandTitle}>VelarOS</p>
  )}
</Button>`,
  },
  {
    id: 'empty-state-large',
    title: 'Chat empty state',
    description:
      'EmptyState stacks a large steady mark with sliding wind lines above WorkspaceSessionControl.',
    preview: (
      <Center className="p-3">
        <VelarSailMark motion="steady" size="large" windLineMotion="slide" animated decorative />
      </Center>
    ),
    code: `// components/chat/panes/EmptyState.tsx
<Stack className={styles.root} align="center" gap="lg">
  <VelarSailMark
    className={styles.brandMark}
    motion="steady"
    size="large"
    windLineMotion="slide"
  />
  <WorkspaceSessionControl
    sessionId={sessionId}
    refreshKey={refreshKey}
    mode={workspaceControl?.mode ?? 'default'}
    readOnly={workspaceControl?.readOnly}
    showAddButton={workspaceControl?.showAddButton}
    variant={workspaceControl?.variant}
  />
</Stack>`,
  },
]
