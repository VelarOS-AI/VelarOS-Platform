import { DebugTimelineExample } from '@catalog/examples/DebugExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.debugTools,
  entryOrder: 0,
  entry: {
    id: 'debug-timeline',
    name: 'Debug Timeline',
    layer: 'Feature',
    status: 'ready',
    domain: 'Debug',
    source: 'component-library adapters (Desktop host reference)',
    origin: 'components/debug/panel',
    exampleMode: 'fixture',
    usage: 'Use to show ordered execution, context and tool trace events with expandable detail.',
    avoid: 'Do not rebuild timeline rails in individual debug tabs.',
    examples: [
      {
        id: 'debug-timeline-fixture',
        label: 'Fixture: timeline events',
        node: <DebugTimelineExample />,
      },
    ],
  },
})
