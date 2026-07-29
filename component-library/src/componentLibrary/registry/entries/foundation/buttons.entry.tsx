import {
  buttonAndIconRecommendations,
  ButtonAuxiliaryExamples,
  ButtonIconInteractiveDemo,
  buttonIconInteractiveDemoCode,
} from '@catalog/examples/FoundationButtonExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 0,
  entry: {
    id: 'buttons',
    name: 'Button / IconButton',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui',
    usage:
      'Button: text or icon+text actions in settings dialogs, destructive confirms, and TopBar secondary actions. IconButton: icon-only anchors in section search popovers and SettingsSection titleAddon rows. CopyButton + DeleteOutlineIconButton: clipboard and destructive icon affordances.',
    avoid:
      'Do not use Button for icon-only targets; do not put visible copy inside IconButton. Keep dialog footers on size="sm" to match Velar settings density.',
    recommendations: buttonAndIconRecommendations,
    apiComponents: ['Button', 'IconButton', 'CopyButton', 'DeleteOutlineIconButton'],
    api: [
      {
        name: 'Button.variant',
        description: 'Visual emphasis for text or icon+text commands.',
        type:
          "'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'destructiveOutline' | 'destructiveGhost' | 'link'",
        defaultValue: "'default'",
        recommended: "'default' for primary, 'outline' for secondary",
      },
      {
        name: 'Button.size',
        description: 'Control height and density.',
        type: "'default' | 'sm' | 'lg' | 'block' | 'icon' | 'icon-sm' | 'icon-lg'",
        defaultValue: "'default'",
        recommended: "'sm' in compact app surfaces",
      },
      {
        name: 'Button.type',
        description: 'HTML button type. Always set it in forms and toolbars.',
        type: "'button' | 'submit' | 'reset'",
        recommended: "'button'",
      },
      {
        name: 'IconButton.label',
        description: 'Accessible label mapped to aria-label and the default title.',
        type: 'string',
        recommended: 'Required',
      },
      {
        name: 'IconButton.size',
        description: 'Icon-only density preset or custom CSS size.',
        type: "'icon' | 'icon-sm' | 'icon-lg' | number | string",
        defaultValue: "'icon'",
        recommended: "'icon-sm' in toolbars, custom 16 in chips",
      },
      {
        name: 'IconButton.variant',
        description: 'Icon button visual treatment.',
        type: "ButtonProps['variant']",
        defaultValue: "'ghost'",
        recommended: "'ghost' by default, 'outline' when isolated",
      },
    ],
    examples: [
      { id: 'button-auxiliary', label: 'Copy + delete outline', node: <ButtonAuxiliaryExamples /> },
      {
        id: 'buttons-interactive-demo',
        label: 'Button / IconButton props',
        node: <ButtonIconInteractiveDemo />,
        code: buttonIconInteractiveDemoCode,
        interactive: true,
      },
    ],
  },
})
