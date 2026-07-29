import { TopBarControlsExample } from '@catalog/examples/ShellExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.shell,
  entryOrder: 10,
  entry: {
    id: 'top-bar-controls',
    name: 'Top Bar Controls',
    layer: 'Feature',
    status: 'ready',
    domain: 'Shell',
    source: 'component-library adapters (Desktop host reference)',
    origin: 'components/shell/TopBar',
    exampleMode: 'fixture',
    usage:
      'Use for shell-level context controls such as workspace selection, Git status and page actions.',
    avoid: 'Do not place feature-local form controls in the global top bar.',
    apiComponents: ['TopBarControlFrame'],
    examples: [
      {
        id: 'top-bar-controls-fixture',
        label: 'Fixture: workspace and Git controls',
        node: <TopBarControlsExample />,
      },
    ],
  },
})
