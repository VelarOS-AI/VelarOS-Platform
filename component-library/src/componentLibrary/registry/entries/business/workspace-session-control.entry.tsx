import { businessComponentExamples } from '@catalog/examples/BusinessExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 0,
  entry: {
    id: 'workspace-session-control',
    name: 'Workspace Session Control',
    layer: 'Business',
    status: 'ready',
    domain: 'Workspace',
    source: 'component-library adapters (Desktop host reference)',
    origin: 'components/business/workspace',
    exampleMode: 'fixture',
    usage: 'Use when a surface needs to display, add or switch the workspace bound to a session.',
    avoid: 'Do not call preload from parent pages to rebuild workspace state already handled here.',
    examples: businessComponentExamples['workspace-session-control'] ?? [],
  },
})
