import {
  DataTableExamples,
  dataTableRecommendations,
} from '@catalog/examples/FoundationDataTableExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 50,
  entry: {
    id: 'data-table',
    name: 'DataTable / BusinessDataTable',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui/primitives/layout/DataTable; @velaros-ai/ui/product/layout/BusinessDataTable',
    usage:
      'DataTable: framed striped grid and pagination for generic dense lists. BusinessDataTable defaults to borderless for settings-style inventories; skill and memory settings extend that primitive—see Recommended usage.',
    avoid:
      'Avoid for free-form chat transcripts; use List or custom cards. Radix has no table primitive—keep semantics on native <table>.',
    recommendations: dataTableRecommendations,
    apiComponents: ['DataTable', 'BusinessDataTable'],
    examples: [{ id: 'data-table', label: 'Table + pagination', node: <DataTableExamples /> }],
  },
})
