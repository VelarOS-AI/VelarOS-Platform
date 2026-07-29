import { businessComponentExamples } from '@catalog/examples/BusinessExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 30,
  entry: {
    id: 'tool-result-live-renderers',
    name: 'Tool Result Live Renderers',
    layer: 'Business',
    status: 'candidate',
    domain: 'Tool result',
    source: '@velaros-ai/ui/conversation',
    origin: 'packages/ui/src/conversation/tool-render',
    exampleMode: 'fixture',
    usage: 'Promote stable renderers that are user-facing outside debug panes.',
    avoid: 'Do not leak debug-only event shapes into normal conversation UI.',
    examples: businessComponentExamples['tool-result-live-renderers'] ?? [],
  },
})
