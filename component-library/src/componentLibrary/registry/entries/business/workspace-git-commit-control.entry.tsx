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
    source: '@velaros-ai/ui',
    origin: 'packages/ui/src/product/git/WorkspaceGitCommitControl',
    exampleMode: 'fixture',
    usage:
      'Use when a chat or workbench surface needs Git branch, commit and sync controls. This business component owns branch filtering, actions and list layout; Button, TopBarControlFrame, SearchField and Popover own their shared appearance and interaction. Hosts provide Git data and action ports.',
    avoid: 'Do not duplicate Git summary fetching or commit behavior inside feature panels.',
    examples: businessComponentExamples['workspace-git-commit-control'] ?? [],
    apiComponents: ['WorkspaceGitCommitControl'],
  },
})
