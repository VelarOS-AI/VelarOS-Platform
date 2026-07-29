import { SidebarExample } from '@catalog/examples/ShellExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.shell,
  entryOrder: 0,
  entry: {
    id: 'app-sidebar',
    name: 'App Sidebar',
    layer: 'Feature',
    status: 'ready',
    domain: 'Shell',
    source: 'component-library adapters (Desktop host reference)',
    origin: 'components/shell/Sidebar',
    exampleMode: 'fixture',
    usage:
      'Use as the primary app navigation and session list shell; feature pages should not recreate its chrome.',
    avoid:
      'Do not duplicate navigation state or session row behavior outside the shell component family.',
    examples: [
      {
        id: 'app-sidebar-fixture',
        label: 'Fixture: expanded sidebar',
        node: <SidebarExample />,
      },
    ],
  },
})
