import {
  velarSailInteractiveDemoCode,
  VelarSailMarkInteractiveDemo,
  velarSailRecommendations,
} from '@catalog/examples/FoundationBrandExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 40,
  entry: {
    id: 'velar-sail-mark',
    name: 'VelarSailMark',
    layer: 'UI',
    status: 'ready',
    domain: 'Brand',
    source: '@velaros-ai/conversation-ui',
    usage:
      'Product sail mark: StartupIntro wraps a larger steady mark with sliding wind lines inside appStartupSailScene; SidebarHeader uses tiny+steady inside the ghost brand Button when collapsed; EmptyState stacks large+steady with sliding wind lines above WorkspaceSessionControl.',
    avoid:
      'Do not stack multiple marks in one dense toolbar row; reserve tiny for rail chrome, splash for startup, and large for empty states and roomy surfaces.',
    recommendations: velarSailRecommendations,
    apiComponents: ['VelarSailMark'],
    api: [
      {
        name: 'VelarSailMark.size',
        description: 'Layout preset controlling artboard bounds and stroke scale.',
        type: "'tiny' | 'small' | 'large' | 'splash'",
        defaultValue: "'large'",
        recommended: "'tiny' in collapsed chrome, 'large' in empty states, 'splash' on startup",
      },
      {
        name: 'VelarSailMark.motion',
        description: 'Animation personality when animated is true.',
        type: "'intro' | 'steady' | 'still'",
        defaultValue: "'intro'",
        recommended: "'steady' for recurring UI chrome",
      },
      {
        name: 'VelarSailMark.animated',
        description: 'Toggles CSS/SVG motion; false pins the mark to the still frame.',
        type: 'boolean',
        defaultValue: 'true',
      },
      {
        name: 'VelarSailMark.windLineMotion',
        description: 'Controls whether decorative wind lines use the original fade animation or a steady slide.',
        type: "'animated' | 'slide'",
        defaultValue: "'animated'",
        recommended: "'slide' for persistent splash and empty-state surfaces",
      },
      {
        name: 'VelarSailMark.decorative',
        description: 'When true, hides the mark from assistive tech via aria-hidden.',
        type: 'boolean',
        defaultValue: 'true',
        recommended: 'false only when the mark is the primary communicated brand',
      },
    ],
    examples: [
      {
        id: 'velar-sail-mark-interactive-demo',
        label: 'Configurable preview',
        node: <VelarSailMarkInteractiveDemo />,
        code: velarSailInteractiveDemoCode,
        interactive: true,
      },
    ],
  },
})
