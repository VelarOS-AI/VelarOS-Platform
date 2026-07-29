import {
  ChoiceControlsInteractiveDemo,
  choiceControlsInteractiveDemoCode,
  ChoiceGeneralComposerMenuSwitchPreview,
  choiceRecommendations,
} from '@catalog/examples/FoundationFormExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 20,
  entry: {
    id: 'choice-controls',
    name: 'Switch / Checkbox / SegmentedControl',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui',
    usage:
      'Switch rows mirror PermissionToggleCard; SegmentedControl is the canonical compact tab/filter surface and shares the same neutral container and selected-tile treatment as Tabs; Checkbox mirrors ToolCatalogPanel tool rows. Those product components are reference compositions—follow this section instead of duplicating them as catalog leaves.',
    avoid:
      'Do not replace SegmentedControl with Tabs for app-level navigation; reserve Tabs for shells such as SettingsPage.',
    recommendations: choiceRecommendations,
    apiComponents: ['Switch', 'Checkbox', 'SegmentedControl', 'RadioGroup', 'Radio'],
    examples: [
      {
        id: 'choice-controls-interactive-demo',
        label: 'Switch / Checkbox / SegmentedControl props',
        node: <ChoiceControlsInteractiveDemo />,
        code: choiceControlsInteractiveDemoCode,
        interactive: true,
      },
      {
        id: 'composer-neutral-switch',
        label: 'Neutral switch inside composer menu',
        node: <ChoiceGeneralComposerMenuSwitchPreview />,
      },
    ],
  },
})
