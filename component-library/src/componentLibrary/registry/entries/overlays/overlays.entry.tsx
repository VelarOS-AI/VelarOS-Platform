import { OverlayExample } from '@catalog/examples/OverlayExamples'

import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.overlays,
  entryOrder: 0,
  entry: {
    id: 'overlays',
    name: 'Dialog / SettingsPanelDialog / Popover / Tooltip / HoverCard / CascadingMenu / ImagePreviewDialog',
    layer: 'UI',
    status: 'ready',
    domain: 'Overlay',
    source: '@velaros-ai/ui/primitives/overlays',
    usage:
      'Use Dialog for generic blocking flows; SettingsPanelDialog for Velar settings-style panels. Popover/AnchoredPopover own positioning, surface appearance and focus lifecycle; choose a search target in onOpenAutoFocus after positioning. Escape restores the trigger, while outside clicks retain their target focus. Tooltip provides hover hints; HoverCard provides hoverable, selectable details that stay open while the pointer is inside them and never take focus; CascadingMenu provides nested menus; ImagePreviewDialog provides attachment review.',
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
      'HoverCard',
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
