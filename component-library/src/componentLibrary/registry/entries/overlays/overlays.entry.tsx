import { OverlayExample } from '@catalog/examples/OverlayExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.overlays,
  entryOrder: 0,
  entry: {
    id: 'overlays',
    name: 'Dialog / SettingsPanelDialog / Popover / Tooltip / CascadingMenu / ImagePreviewDialog',
    layer: 'UI',
    status: 'ready',
    domain: 'Overlay',
    source: '@velaros-ai/ui/primitives/overlays',
    usage:
      'Use Dialog for generic blocking flows; SettingsPanelDialog for Velar settings-style panels (soft chroming, footer band). Popover/AnchoredPopover for contextual surfaces; Tooltip for hover hints; CascadingMenu for nested menus with lifecycle-safe delayed close; ImagePreviewDialog for attachment review.',
    avoid:
      'Do not use overlays as page layout. Keep menus compact and avoid hidden side effects in examples.',
    apiComponents: [
      'DialogContent',
      'SettingsPanelDialog',
      'Popover',
      'PopoverAnchor',
      'PopoverContent',
      'AnchoredPopover',
      'TooltipContent',
      'BubbleTooltip',
      'CascadingMenu',
      'BusinessCascadingMenu',
      'BusinessCascadingMenuItem',
      'BusinessCascadingMenuSelectedIndicator',
      'BusinessCascadingSubmenuSection',
      'ImagePreviewDialog',
    ],
    examples: [
      {
        id: 'overlay-fixture',
        label: 'Fixture: overlay controls',
        node: <OverlayExample />,
      },
    ],
  },
})
