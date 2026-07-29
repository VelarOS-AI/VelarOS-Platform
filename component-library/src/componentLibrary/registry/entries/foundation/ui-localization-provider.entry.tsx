import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 5,
  entry: {
    id: 'ui-localization-provider',
    name: 'UiLocalizationProvider',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui/i18n/UiLocalizationProvider',
    usage:
      'Wrap the application UI with one locale message contract so shared primitives expose consistent labels, placeholders and accessibility text.',
    avoid:
      'Do not hard-code translated copy inside shared primitives or create feature-local localization contexts for messages already covered by UiLocalizationMessages.',
    apiComponents: ['UiLocalizationProvider'],
    examples: [],
  },
})
