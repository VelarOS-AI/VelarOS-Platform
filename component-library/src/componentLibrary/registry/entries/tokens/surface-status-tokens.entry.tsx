import { SurfaceTokenExamples } from '@catalog/examples/TokenExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.tokens,
  entryOrder: 10,
  entry: {
    id: 'surface-status-tokens',
    name: 'Surface / Status Tokens',
    layer: 'Token',
    status: 'ready',
    domain: 'Main window',
    source: 'index.css :root semantic tokens',
    usage:
      'Use semantic surface, border and status tokens before choosing raw color values. Listed values mirror the live theme on :root.',
    avoid: 'Avoid encoding status colors inside individual components or feature CSS modules.',
    examples: [{ id: 'surface-token-scale', label: 'Color scale', node: <SurfaceTokenExamples /> }],
  },
})
