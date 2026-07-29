import {
  fieldRecommendations,
  InputExtensionExamples,
} from '@catalog/examples/FoundationFormExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 10,
  entry: {
    id: 'fields',
    name: 'Input / Select / TextSelect / Textarea / NumberInput / Picker / Calendar / Date Range / TimePicker',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui',
    usage:
      'Dense settings forms use Select + Textarea with size="sm" and Input inside AnchoredPopover search surfaces. Scheduled tasks compose CalendarDatePicker + TimePicker instead of native datetime popovers. Date ranges that must always have a value set showClearAction={false} instead of remapping Clear to Today. Model and system rows reuse the same primitives—see Recommended usage for source index.',
    avoid:
      'Keep IPC DTOs out of raw inputs; map to view models in hooks/settings before rendering.',
    recommendations: fieldRecommendations,
    apiComponents: [
      'Input',
      'Select',
      'TextSelect',
      'Textarea',
      'NumberInput',
      'Picker',
      'Calendar',
      'CalendarDatePicker',
      'CalendarRange',
      'CalendarDateRangePicker',
      'TimePicker',
    ],
    examples: [
      {
        id: 'input-extensions',
        label: 'Numeric / picker helpers',
        node: <InputExtensionExamples />,
      },
    ],
  },
})
