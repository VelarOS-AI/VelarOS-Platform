import {
  DisclosureExamples,
  disclosureRecommendations,
} from '@catalog/examples/FoundationOverlayExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 80,
  entry: {
    id: 'disclosure-surfaces',
    name: 'Disclosure / ToolDisclosureCard / CollapsibleBlockFrame / CompactToolRow',
    layer: 'UI',
    status: 'ready',
    domain: 'Debug / Tool output',
    source:
      '@velaros-ai/ui/primitives/layout/Disclosure, CollapsibleBlockFrame; @velaros-ai/ui/product (ToolDisclosureCard, CompactToolRow)',
    usage:
      'Disclosure: grouped settings or catalog sections (ToolCatalogPanel). ToolDisclosureCard: chat tool headers with expandable detail (ToolCallBlock). WidgetToolRender uses an always-expanded shell with a muted header. CompactToolRow: single-line tool summary rows inside cards or compact lists.',
    avoid:
      'Do not hand-roll `<details>` chrome in debug renderers when these primitives exist; avoid duplicating status dots outside ToolDisclosureCard.',
    recommendations: disclosureRecommendations,
    apiComponents: ['Disclosure', 'ToolDisclosureCard', 'CollapsibleBlockFrame', 'CompactToolRow'],
    examples: [{ id: 'disclosure-surfaces', label: 'Disclosure surfaces', node: <DisclosureExamples /> }],
  },
})
