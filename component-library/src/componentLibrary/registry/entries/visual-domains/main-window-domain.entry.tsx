import { MainWindowDomainExamples } from '@catalog/examples/VisualExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.visualDomains,
  entryOrder: 0,
  entry: {
    id: 'main-window-domain',
    name: 'Main Window Domain',
    layer: 'Visual',
    status: 'ready',
    domain: 'Chat / Settings / Shell',
    source: 'index.css --ui-*',
    usage: 'Use as the default product surface: calm density, soft panels, shared UI tokens.',
    avoid: 'Avoid importing workbench-only tokens into chat, settings or shell components.',
    examples: [{ id: 'main-window-preview', label: 'Surface', node: <MainWindowDomainExamples /> }],
  },
})
