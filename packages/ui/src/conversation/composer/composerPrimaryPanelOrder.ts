/**
 * 聊天输入「+」菜单**主面板**槽位顺序（自上而下）。
 *
 * - {@link import('./ComposerAddMenu.tsx').ComposerAddMenu} 主列表
 *
 * 主面板只保留用户主动打开菜单时仍需要展开的入口；外置功能和活动芯片顺序由
 * {@link COMPOSER_FUNCTION_BAR_CHIP_ORDER} 管理。
 */
export const COMPOSER_PRIMARY_PANEL_SLOT_ORDER = [
  'quick-prompts',
  'attachments',
  'capabilities',
  'plan',
  'workbench-editor',
  'goal',
  'plugins',
  'skills',
] as const

export type ComposerPrimaryPanelSlotId = (typeof COMPOSER_PRIMARY_PANEL_SLOT_ORDER)[number]

/** FunctionBar 活动芯片顺序；仅展示已启用且适合快速关闭的能力。 */
export const COMPOSER_FUNCTION_BAR_CHIP_ORDER = [
  'plan',
  'goal',
  'capabilities',
  'browser-elements',
  'turn-context',
  'plugins',
  'skills',
  'mentions',
] as const

export type ComposerFunctionBarChipSlotId = (typeof COMPOSER_FUNCTION_BAR_CHIP_ORDER)[number]

export type ComposerFunctionBarChipStyle = 'execution' | 'legacy'
export type ComposerFunctionBarChipPlacement = 'persistent' | 'legacy'

export const COMPOSER_FUNCTION_BAR_CHIP_CONFIG = {
  plan: {
    chipStyle: 'execution',
    placement: 'persistent',
  },
  goal: {
    chipStyle: 'execution',
    placement: 'persistent',
  },
  capabilities: {
    chipStyle: 'execution',
    placement: 'persistent',
  },
  'browser-elements': {
    chipStyle: 'legacy',
    placement: 'legacy',
  },
  'turn-context': {
    chipStyle: 'legacy',
    placement: 'legacy',
  },
  plugins: {
    chipStyle: 'legacy',
    placement: 'legacy',
  },
  skills: {
    chipStyle: 'legacy',
    placement: 'legacy',
  },
  mentions: {
    chipStyle: 'legacy',
    placement: 'legacy',
  },
} satisfies Record<
  ComposerFunctionBarChipSlotId,
  { chipStyle: ComposerFunctionBarChipStyle; placement: ComposerFunctionBarChipPlacement }
>
