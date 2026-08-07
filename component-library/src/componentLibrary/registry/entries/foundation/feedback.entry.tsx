import {
  BadgeExamples,
  BadgePanelInteractiveDemo,
  badgePanelInteractiveDemoCode,
  feedbackRecommendations,
  PanelExamples,
  SettingsLayoutExamples,
  StatusFeedbackExamples,
} from '@catalog/examples/FoundationFeedbackExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 30,
  entry: {
    id: 'feedback',
    name: 'Badge / Panel / ActionCard / Settings',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui (ActionCard, Settings primitives)',
    usage:
      'ActionCard provides compact operation feedback in chat; Badge/Panel/Settings primitives compose settings sections such as ModelSettingsSection cards.',
    avoid:
      'Keep ActionCard copy to a single detail line; push tables or long prose into SettingsCard / Panel instead.',
    recommendations: feedbackRecommendations,
    apiComponents: [
      'Badge',
      'Panel',
      'ActionCard',
      'ActionCardIconButton',
      'Progress',
      'Result',
      'Skeleton',
      'Spin',
      'SettingsSection',
      'SettingsRow',
      'SettingsStatus',
    ],
    api: [
      {
        name: 'ActionCard.title',
        description: 'Primary one-line label shown beside the leading icon.',
        type: 'ReactNode',
      },
      {
        name: 'ActionCard.description',
        description: 'Single compact detail line; pass already-formatted workspace paths.',
        type: 'ReactNode',
      },
      {
        name: 'ActionCard.actions',
        description: 'Right-side action slot, usually composed with ActionCardIconButton.',
        type: 'ReactNode',
      },
      {
        name: 'ActionCardIconButton.label',
        description: 'Accessible action label used for tooltip/title and aria-label.',
        type: 'string',
      },
    ],
    examples: [
      {
        id: 'feedback-interactive-demo',
        label: 'Badge / Panel props',
        node: <BadgePanelInteractiveDemo />,
        code: badgePanelInteractiveDemoCode,
        interactive: true,
      },
      { id: 'badges', label: 'Badges', node: <BadgeExamples /> },
      { id: 'panels', label: 'Panels', node: <PanelExamples /> },
      {
        id: 'status-feedback',
        label: 'Progress / Spin / Skeleton / Result',
        node: <StatusFeedbackExamples />,
      },
      { id: 'settings-layout', label: 'Settings layout', node: <SettingsLayoutExamples /> },
    ],
  },
})
