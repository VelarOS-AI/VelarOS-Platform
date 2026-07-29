import { tabsRecommendations } from '@catalog/examples/FoundationLayoutExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 90,
  entry: {
    id: 'tabs',
    name: 'Tabs',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui/primitives/layout/Tabs',
    usage:
      'Use the shared Radix Tabs for page and settings navigation. TabsList and TabsTrigger provide the canonical neutral segmented surface: gray container, white selected tile, thin border, and low elevation.',
    avoid:
      'Do not reuse this shell for chat-level navigation; keep chat navigation in shell/top bar patterns.',
    recommendations: tabsRecommendations,
    apiComponents: ['TabsList', 'TabsTrigger', 'TabsContent'],
    examples: [],
  },
})
