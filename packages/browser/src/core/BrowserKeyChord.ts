import { isEmpty } from '@velaros-ai/core'

import type { BrowserKeyModifier, BrowserPressKeyOptions } from './types.js'

const KeyModifierAliases = new Map<string, BrowserKeyModifier>([
  ['shift', 'shift'],
  ['control', 'control'],
  ['ctrl', 'control'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['meta', 'meta'],
  ['cmd', 'meta'],
  ['command', 'meta'],
])

const KeyModifierOrder: BrowserKeyModifier[] = ['shift', 'control', 'alt', 'meta']

export function normalizeBrowserPressKeyOptions(
  options: BrowserPressKeyOptions
): BrowserPressKeyOptions {
  const parts = options.key.split('+')
  if (parts.length < 2) return options

  const modifiers = new Set<BrowserKeyModifier>(options.modifiers ?? [])
  const keyParts: string[] = []
  let foundChordModifier = false

  for (const part of parts) {
    const trimmed = part.trim()
    const modifier = KeyModifierAliases.get(trimmed.toLowerCase())
    if (modifier) {
      modifiers.add(modifier)
      foundChordModifier = true
    } else if (!isEmpty(trimmed)) {
      keyParts.push(trimmed)
    }
  }

  if (!foundChordModifier || isEmpty(keyParts)) return options

  return {
    ...options,
    key: keyParts.join('+'),
    modifiers: KeyModifierOrder.filter((modifier) => modifiers.has(modifier)),
  }
}
