import type { CSSProperties } from 'react'

/** 仅前景：在既有背景上推导可读文字色。 */
export type TintedSurfaceForegroundStyle = CSSProperties & {
  '--tinted-surface-fg': string
}

interface Rgb {
  r: number
  g: number
  b: number
}

interface Hsl {
  h: number
  s: number
  l: number
}

const FALLBACK_FOREGROUND_STYLE: TintedSurfaceForegroundStyle = {
  '--tinted-surface-fg': 'var(--status-blue)',
}

const foregroundCache = new Map<string, TintedSurfaceForegroundStyle>()

const MIN_TEXT_CONTRAST = 4.5
const MIN_SATURATION = 0.38
const MAX_SATURATION = 0.86
const NEUTRAL_SATURATION_THRESHOLD = 0.08
const DARK_CONTENT_LIGHTNESS = 0.78
const DARK_CONTENT_LIGHTNESS_MAX = 0.88

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export function parseHexColor(color: Optional<string>): Nullable<Rgb> {
  if (!color) return null

  const value = color.trim()
  const hex = value.startsWith('#') ? value.slice(1) : value
  if (/^[0-9a-fA-F]{3}$/.test(hex))
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    }

  if (/^[0-9a-fA-F]{6}$/.test(hex))
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }

  return null
}

export const rgbToHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b]
    .map((channel) =>
      Math.round(clamp(channel, 0, 255))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`

/** `color-mix(in srgb, rgb(a) α%, transparent)` 叠在 #fff 上的近似 rgb。 */
export function compositeRgbOnWhite(r: number, g: number, b: number, alpha: number): Rgb {
  const weight = clamp(alpha, 0, 1)
  return {
    r: 255 * (1 - weight) + r * weight,
    g: 255 * (1 - weight) + g * weight,
    b: 255 * (1 - weight) + b * weight,
  }
}

const rgbToHsl = ({ r, g, b }: Rgb): Hsl => {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const l = (max + min) / 2

  if (max === min) return { h: 0, s: 0, l }

  const delta = max - min
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let h: number
  if (max === red) h = (green - blue) / delta + (green < blue ? 6 : 0)
  else if (max === green) h = (blue - red) / delta + 2
  else h = (red - green) / delta + 4

  return { h: h * 60, s, l }
}

const hslToRgb = ({ h, s, l }: Hsl): Rgb => {
  const hue = (((h % 360) + 360) % 360) / 360

  if (s === 0) {
    const value = l * 255
    return { r: value, g: value, b: value }
  }

  const hueToRgb = (p: number, q: number, t: number): number => {
    let next = t
    if (next < 0) next += 1
    if (next > 1) next -= 1
    if (next < 1 / 6) return p + (q - p) * 6 * next
    if (next < 1 / 2) return q
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6
    return p
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  return {
    r: hueToRgb(p, q, hue + 1 / 3) * 255,
    g: hueToRgb(p, q, hue) * 255,
    b: hueToRgb(p, q, hue - 1 / 3) * 255,
  }
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  const toLinear = (channel: number): number => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

const makeColor = (h: number, s: number, l: number): Rgb => hslToRgb({ h, s, l: clamp(l, 0, 1) })

const getReadableSaturation = (saturation: number): number =>
  saturation < NEUTRAL_SATURATION_THRESHOLD ? 0 : clamp(saturation, MIN_SATURATION, MAX_SATURATION)

const deriveLightForeground = (accent: Hsl, background: Rgb): string => {
  const tagSaturation = getReadableSaturation(accent.s)
  let contentLightness = clamp(Math.min(accent.l * 0.7, 0.34), 0.18, 0.34)
  let content = makeColor(accent.h, tagSaturation, contentLightness)

  while (contrastRatio(content, background) < MIN_TEXT_CONTRAST && contentLightness > 0.08) {
    contentLightness -= 0.025
    content = makeColor(accent.h, tagSaturation, contentLightness)
  }

  return rgbToHex(content)
}

const deriveDarkForeground = (accent: Hsl, background: Rgb): string => {
  const tagSaturation = getReadableSaturation(accent.s)
  let contentLightness = DARK_CONTENT_LIGHTNESS
  let content = makeColor(accent.h, tagSaturation, contentLightness)

  while (
    contrastRatio(content, background) < MIN_TEXT_CONTRAST &&
    contentLightness < DARK_CONTENT_LIGHTNESS_MAX
  ) {
    contentLightness += 0.02
    content = makeColor(accent.h, tagSaturation, contentLightness)
  }

  while (contrastRatio(content, background) < MIN_TEXT_CONTRAST && contentLightness > 0.08) {
    contentLightness -= 0.025
    content = makeColor(accent.h, tagSaturation, contentLightness)
  }

  return rgbToHex(content)
}

/**
 * 给定 accent 与**已有背景**（hex），仅推导可读前景色；背景仍由 CSS token 负责。
 */
export function getTintedSurfaceForeground(
  accentColor: Optional<string>,
  backgroundColor: Optional<string>,
  isDarkMode: boolean
): TintedSurfaceForegroundStyle {
  const accentRgb = parseHexColor(accentColor)
  const backgroundRgb = parseHexColor(backgroundColor)
  if (!accentRgb || !backgroundRgb) return FALLBACK_FOREGROUND_STYLE

  const mode = isDarkMode ? 'dark' : 'light'
  const cacheKey = `${mode}:${rgbToHex(accentRgb).toLowerCase()}:${rgbToHex(backgroundRgb).toLowerCase()}`
  const cached = foregroundCache.get(cacheKey)
  if (cached) return cached

  const accentHsl = rgbToHsl(accentRgb)
  const foreground = isDarkMode
    ? deriveDarkForeground(accentHsl, backgroundRgb)
    : deriveLightForeground(accentHsl, backgroundRgb)

  const style: TintedSurfaceForegroundStyle = {
    '--tinted-surface-fg': foreground,
  }
  foregroundCache.set(cacheKey, style)
  return style
}
