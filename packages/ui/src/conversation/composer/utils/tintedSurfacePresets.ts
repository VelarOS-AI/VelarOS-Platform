import type { CSSProperties } from 'react'

import {
  compositeRgbOnWhite,
  getTintedSurfaceForeground,
  rgbToHex,
  type TintedSurfaceForegroundStyle,
} from './tintedSurfaceStyle'

/** 与 `theme-light.css` status / metric token 对齐的 accent 基色（hex）。 */
export const TintedSurfaceAccentHex = {
  blue: '#6b7280',
  green: '#15803d',
  red: '#dc2626',
  amber: '#d97706',
  violet: '#7c3aed',
  slate: '#3f5f97',
  teal: '#0f766e',
  emerald: '#047857',
  orange: '#f97316',
  neutral: '#737373',
  brandChrome: '#1a73e8',
} as const

export type TintedSurfaceAccentHexKey = keyof typeof TintedSurfaceAccentHex

/** CSS soft / color-mix 背景在 #fff 上的近似 hex，仅用于前景对比度计算。 */
export const TintedSurfaceBackgroundHex = {
  blueSoft: rgbToHex(compositeRgbOnWhite(107, 114, 128, 0.11)),
  greenSoft: rgbToHex(compositeRgbOnWhite(21, 128, 61, 0.1)),
  redSoft: rgbToHex(compositeRgbOnWhite(220, 38, 38, 0.1)),
  amberSoft: rgbToHex(compositeRgbOnWhite(217, 119, 6, 0.1)),
  violetSoft: rgbToHex(compositeRgbOnWhite(124, 58, 237, 0.11)),
  slateSoft: rgbToHex(compositeRgbOnWhite(63, 95, 151, 0.12)),
  tealSoft: rgbToHex(compositeRgbOnWhite(15, 118, 110, 0.11)),
  emeraldSoft: rgbToHex(compositeRgbOnWhite(4, 120, 87, 0.11)),
  taskSoft: rgbToHex(compositeRgbOnWhite(249, 115, 22, 0.18)),
  brandChromeSoft: rgbToHex(compositeRgbOnWhite(66, 133, 244, 0.13)),
} as const

export type TintedSurfacePreset = {
  accent: string
  /** 与 CSS 背景 token 对齐的近似 hex，不写入 DOM。 */
  background: string
}

export function buildTintedSurfaceForegroundStyle(
  preset: TintedSurfacePreset,
  isDarkMode: boolean
): TintedSurfaceForegroundStyle {
  return getTintedSurfaceForeground(preset.accent, preset.background, isDarkMode)
}

export function resolveComposerChipTintedPreset(input: {
  chipDataPluginId?: string
  chipDataSkillId?: string
  tone?: 'default' | 'experimental'
}): TintedSurfacePreset {
  if (input.chipDataSkillId)
    return { accent: TintedSurfaceAccentHex.teal, background: TintedSurfaceBackgroundHex.tealSoft }

  if (input.tone === 'experimental')
    return { accent: TintedSurfaceAccentHex.red, background: TintedSurfaceBackgroundHex.redSoft }

  switch (input.chipDataPluginId) {
    case 'goal-mode':
      return {
        accent: TintedSurfaceAccentHex.emerald,
        background: TintedSurfaceBackgroundHex.emeraldSoft,
      }
    case 'web-search':
      return {
        accent: TintedSurfaceAccentHex.blue,
        background: TintedSurfaceBackgroundHex.blueSoft,
      }
    case 'browser':
      return {
        accent: TintedSurfaceAccentHex.brandChrome,
        background: TintedSurfaceBackgroundHex.brandChromeSoft,
      }
    case 'run-profile':
    case 'office-latex-pdf':
    case 'widget':
      return {
        accent: TintedSurfaceAccentHex.violet,
        background: TintedSurfaceBackgroundHex.violetSoft,
      }
    case 'office-spreadsheet':
      return {
        accent: TintedSurfaceAccentHex.green,
        background: TintedSurfaceBackgroundHex.greenSoft,
      }
    case 'permissions':
    case 'office':
    case 'office-pdf':
      return { accent: TintedSurfaceAccentHex.red, background: TintedSurfaceBackgroundHex.redSoft }
    case 'office-presentation':
      return {
        accent: TintedSurfaceAccentHex.amber,
        background: TintedSurfaceBackgroundHex.amberSoft,
      }
    case 'office-document':
      return {
        accent: TintedSurfaceAccentHex.blue,
        background: TintedSurfaceBackgroundHex.blueSoft,
      }
    case 'browser-element':
    case 'plan':
    case 'auto-memory':
      return {
        accent: TintedSurfaceAccentHex.blue,
        background: TintedSurfaceBackgroundHex.blueSoft,
      }
    case 'workbench-comment':
      return {
        accent: TintedSurfaceAccentHex.orange,
        background: TintedSurfaceBackgroundHex.taskSoft,
      }
    default:
      return {
        accent: TintedSurfaceAccentHex.blue,
        background: TintedSurfaceBackgroundHex.blueSoft,
      }
  }
}

export function resolveComposerChipTintedForegroundStyle(
  input: {
    chipDataPluginId?: string
    chipDataSkillId?: string
    tone?: 'default' | 'experimental'
  },
  isDarkMode: boolean
): TintedSurfaceForegroundStyle {
  return buildTintedSurfaceForegroundStyle(resolveComposerChipTintedPreset(input), isDarkMode)
}

export function mergeTintedSurfaceForegroundStyle(
  style: TintedSurfaceForegroundStyle,
  extra?: CSSProperties
): TintedSurfaceForegroundStyle {
  return extra ? { ...style, ...extra } : style
}
