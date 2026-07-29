import {
  LayoutPrimitiveExamples,
  layoutRecommendations,
} from '@catalog/examples/FoundationLayoutExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 70,
  entry: {
    id: 'layout-primitives',
    name: 'Stack / Inline / Flex / Grid / Space / Row·Col / Card / ListGroup / Typography / Descriptions / Divider / Tag / Empty / Center / List / ScrollArea / HoverRevealRow / CollapsibleNav / AppShell',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui (AppShell, CollapsibleNav)',
    usage:
      'Use layout primitives to compose dense surfaces before adding feature-specific CSS. Stack & Inline remain the default vertical/horizontal stacks; Flex adds an antd-style flex primitive; Grid / Row·Col cover grids; Space adds gap + optional split; Card & ListGroup group chrome; Title / Paragraph / Text replace ad-hoc headings and copy; DescriptionList + DescriptionItem mirror antd Descriptions; Divider covers section breaks (with optional label); Tag is softer than Badge for metadata; Empty + Center standardize blank states. HoverRevealRow exposes trailing actions for dense rows without permanent chrome. AppShell matches App.tsx. Separator stays the Radix divider for menus/forms.',
    avoid:
      'Avoid one-off spacing wrappers when Stack, Inline, List or ScrollArea already express the structure; avoid hand-rolled hover/focus overlays when HoverRevealRow already matches the dense-row action pattern.',
    recommendations: layoutRecommendations,
    apiComponents: [
      'Stack',
      'Inline',
      'Flex',
      'Grid',
      'Space',
      'Row',
      'Col',
      'Card',
      'ListGroup',
      'ListGroupItem',
      'Title',
      'Paragraph',
      'Text',
      'Link',
      'FileTypeIcon',
      'DescriptionList',
      'DescriptionItem',
      'Divider',
      'Tag',
      'Empty',
      'Center',
      'List',
      'ScrollArea',
      'HoverRevealRow',
      'BreadcrumbItem',
      'Steps',
      'CollapsibleNav',
      'AppShell',
    ],
    examples: [{ id: 'layout-primitives', label: 'Layout primitives', node: <LayoutPrimitiveExamples /> }],
  },
})
