import { businessComponentExamples } from '@catalog/examples/BusinessExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 10,
  entry: {
    id: 'workspace-git-commit-control',
    name: 'Workspace Git Commit Control',
    layer: 'Business',
    status: 'ready',
    domain: 'Git',
    source: 'component-library adapters (Desktop host reference)',
    origin: 'components/business/git',
    exampleMode: 'fixture',
    usage:
      'Use when a chat or workbench surface needs the shared Git branch, commit and sync affordance.',
    avoid: 'Do not duplicate Git summary fetching or commit behavior inside feature panels.',
    examples: businessComponentExamples['workspace-git-commit-control'] ?? [],
  },
})
