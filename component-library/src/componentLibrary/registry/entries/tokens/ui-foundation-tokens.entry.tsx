import { UiTokenExamples } from '@catalog/examples/TokenExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.tokens,
  entryOrder: 0,
  entry: {
    id: 'ui-foundation-tokens',
    name: 'UI Foundation Tokens',
    layer: 'Token',
    status: 'ready',
    domain: 'Main window + shared UI',
    source: 'index.css :root --ui-*',
    usage:
      'Use for shared typography, spacing, radius and control density across UI and business components. The library table resolves values at runtime from :root.',
    avoid: 'Avoid one-off px values for repeated component sizing; add or reuse a token first.',
    examples: [{ id: 'ui-token-scale', label: 'Token scale', node: <UiTokenExamples /> }],
  },
})
