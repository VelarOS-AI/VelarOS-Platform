import {
  BusinessSurfaceExamples,
  businessSurfaceRecommendations,
} from '@catalog/examples/FoundationBusinessSurfaceExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 60,
  entry: {
    id: 'business-surfaces',
    name: 'BusinessSurface',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui/product/layout/BusinessSurface',
    usage:
      'Borderless tonal blocks for dialog bodies and inspect panels such as SkillEditorDialog editors. Prefer over ad-hoc bordered boxes inside SettingsPanelDialog.',
    avoid: 'Do not replace Panel chrome in generic layouts; reserve BusinessSurface for Velar business/read-only blocks.',
    recommendations: businessSurfaceRecommendations,
    apiComponents: ['BusinessSurface'],
    examples: [{ id: 'business-surface-variants', label: 'Variants', node: <BusinessSurfaceExamples /> }],
  },
})
