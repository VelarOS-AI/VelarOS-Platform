import { EditorDomainExamples } from '@catalog/examples/VisualExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.visualDomains,
  entryOrder: 10,
  entry: {
    id: 'editor-domain',
    name: 'Editor Domain',
    layer: 'Visual',
    status: 'planned',
    domain: 'Workbench',
    source: 'WorkbenchPage.module.css --workbench-*',
    usage:
      'Workbench --workbench-* tokens alias global semantics (background, borders, accents) while keeping dense layout chrome in WorkbenchPage.module.css.',
    avoid: 'Avoid creating a second behavior stack; adapt shared UI through scope and variants.',
    examples: [{ id: 'editor-preview', label: 'Surface', node: <EditorDomainExamples /> }],
  },
})
