import { businessComponentExamples } from '@catalog/examples/BusinessExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 20,
  entry: {
    id: 'tool-result-summary-list',
    name: 'Tool Result Summary List',
    layer: 'Business',
    status: 'ready',
    domain: 'Tool result',
    source: '@velaros-ai/conversation-ui',
    origin: 'packages/conversation-ui/src/blocks',
    exampleMode: 'fixture',
    usage:
      'Use for compact, grouped summaries of tool activity in chat, debug or workbench surfaces.',
    avoid: 'Do not pass raw ToolCallBlock payloads; map tool state into a stable view model first.',
    examples: businessComponentExamples['tool-result-summary-list'] ?? [],
  },
})
