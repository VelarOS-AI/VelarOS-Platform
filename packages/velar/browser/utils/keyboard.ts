import { isEmpty, isNotNull } from '@velaros-ai/core'

import type { BrowserKeyModifier, BrowserPressKeyOptions } from '../types/browser.js'
import type { BrowserKeyDefinition, BrowserPageDriverKeyEvent } from '../types/driver.js'

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

/** 修饰键的 DOM key 值与它在 CDP 位掩码里的位（Alt 1、Control 2、Meta 4、Shift 8）。 */
const ModifierBits: Readonly<Record<string, number>> = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 })

/** 修饰键在 press 的 modifiers 里的写法 → DOM key 值。 */
const ModifierKeyNames: Readonly<Record<BrowserKeyModifier, string>> = Object.freeze({
  shift: 'Shift',
  control: 'Control',
  alt: 'Alt',
  meta: 'Meta',
})

/** 不出字的键：DOM key 值 → [code, keyCode]。修饰键记左边那个。 */
const NamedKeys: Readonly<Record<string, readonly [string, number]>> = Object.freeze({
  Enter: ['Enter', 13],
  Tab: ['Tab', 9],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  Escape: ['Escape', 27],
  Insert: ['Insert', 45],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40],
  Shift: ['ShiftLeft', 16],
  Control: ['ControlLeft', 17],
  Alt: ['AltLeft', 18],
  Meta: ['MetaLeft', 91],
  CapsLock: ['CapsLock', 20],
  ContextMenu: ['ContextMenu', 93],
  PrintScreen: ['PrintScreen', 44],
  Pause: ['Pause', 19],
  NumLock: ['NumLock', 144],
  ScrollLock: ['ScrollLock', 145],
  F1: ['F1', 112],
  F2: ['F2', 113],
  F3: ['F3', 114],
  F4: ['F4', 115],
  F5: ['F5', 116],
  F6: ['F6', 117],
  F7: ['F7', 118],
  F8: ['F8', 119],
  F9: ['F9', 120],
  F10: ['F10', 121],
  F11: ['F11', 122],
  F12: ['F12', 123],
})

/** 键名的别名（小写）→ DOM key 值：Electron 加速键的写法与常见缩写。 */
const KeyNameAliases: Readonly<Record<string, string>> = Object.freeze({
  return: 'Enter',
  esc: 'Escape',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  ctrl: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  option: 'Alt',
  space: ' ',
  spacebar: ' ',
  plus: '+',
})

/** 标点：字符 → [code, keyCode, 这是按着 Shift 打出来的]。 */
const PunctuationKeys: Readonly<Record<string, readonly [string, number, boolean]>> = Object.freeze({
  ' ': ['Space', 32, false],
  '-': ['Minus', 189, false],
  _: ['Minus', 189, true],
  '=': ['Equal', 187, false],
  '+': ['Equal', 187, true],
  '[': ['BracketLeft', 219, false],
  '{': ['BracketLeft', 219, true],
  ']': ['BracketRight', 221, false],
  '}': ['BracketRight', 221, true],
  '\\': ['Backslash', 220, false],
  '|': ['Backslash', 220, true],
  ';': ['Semicolon', 186, false],
  ':': ['Semicolon', 186, true],
  "'": ['Quote', 222, false],
  '"': ['Quote', 222, true],
  ',': ['Comma', 188, false],
  '<': ['Comma', 188, true],
  '.': ['Period', 190, false],
  '>': ['Period', 190, true],
  '/': ['Slash', 191, false],
  '?': ['Slash', 191, true],
  '`': ['Backquote', 192, false],
  '~': ['Backquote', 192, true],
  '!': ['Digit1', 49, true],
  '@': ['Digit2', 50, true],
  '#': ['Digit3', 51, true],
  $: ['Digit4', 52, true],
  '%': ['Digit5', 53, true],
  '^': ['Digit6', 54, true],
  '&': ['Digit7', 55, true],
  '*': ['Digit8', 56, true],
  '(': ['Digit9', 57, true],
  ')': ['Digit0', 48, true],
})

/** macOS 上 Meta 加这些键带的编辑命令：那里的快捷键不经页面，要靠命令名生效。 */
const MacEditingCommands: Readonly<Record<string, string>> = Object.freeze({
  a: 'selectAll',
  c: 'copy',
  x: 'cut',
  v: 'paste',
  z: 'undo',
  Z: 'redo',
})

/** 把按键入参归一化：键名大小写、修饰键去重、次数夹进区间。 */
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

/** 把键名认成美式键盘上的一个键：键名（Enter、ArrowDown、F5，大小写与常见别名都认）或一个字符；认不出来返回 null。 */
export function resolveKeyDefinition(name: string): Nullable<BrowserKeyDefinition> {
  const alias = KeyNameAliases[name.toLowerCase()]
  const key = alias ?? name
  if ([...key].length === 1) return resolveCharacterKey(key)
  const named = Object.keys(NamedKeys).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
  if (!named) return null
  const [code, keyCode] = NamedKeys[named]!
  const definition: BrowserKeyDefinition = { key: named, code, keyCode }
  if (named === 'Enter') definition.text = '\r'
  if (named in ModifierBits) definition.location = 1
  return definition
}

/** 一个字符的键：字母、数字、标点按美式键盘的键位，别的字符（中文、带音调的字母）没有键位，只上屏。 */
function resolveCharacterKey(character: string): BrowserKeyDefinition {
  if (/^[a-z]$/iu.test(character)) {
    const upper = character.toUpperCase()
    return { key: character, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: character, shifted: upper }
  }
  if (/^[0-9]$/u.test(character)) return { key: character, code: `Digit${character}`, keyCode: character.charCodeAt(0), text: character }
  const punctuation = PunctuationKeys[character]
  if (punctuation) {
    const [code, keyCode] = punctuation
    return { key: character, code, keyCode, text: character }
  }
  return { key: character, code: '', keyCode: 0, text: character }
}

/** 键名认不认得：入参核对用；组合键（Control+a）先拆成修饰键与主键再认。 */
export function isKnownKeyName(name: string): boolean {
  const normalized = normalizeBrowserPressKeyOptions({ key: name })
  return isNotNull(resolveKeyDefinition(normalized.key))
}

/** press 的 modifiers 写法换成修饰键的 DOM key 值（shift → Shift）。 */
export function modifierKeyName(modifier: BrowserKeyModifier): string {
  return ModifierKeyNames[modifier]
}

/** 按着的键里修饰键折成 CDP 位掩码。 */
export function modifiersMask(held: Iterable<string>): number {
  let mask = 0
  for (const key of held) mask |= ModifierBits[key] ?? 0
  return mask
}

/** 按下一个键的 CDP 事件：Shift 按着时字母大写；Control、Alt、Meta 按着时不上屏；macOS 上 Meta 加 a、c、x、v、z 带编辑命令。 */
export function buildKeyDownEvent(
  definition: BrowserKeyDefinition,
  held: ReadonlySet<string>,
  mac: boolean
): BrowserPageDriverKeyEvent {
  const shift = held.has('Shift')
  const key = shift && definition.shifted ? definition.shifted : definition.key
  const typing = !held.has('Control') && !held.has('Alt') && !held.has('Meta')
  const text = typing ? (shift && definition.shifted ? definition.shifted : definition.text) : undefined
  const event: BrowserPageDriverKeyEvent = {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    modifiers: modifiersMask(held),
  }
  if (text) {
    event.text = text
    event.unmodifiedText = text
  }
  if (definition.location) event.location = definition.location
  const command = mac && held.has('Meta') ? MacEditingCommands[key] : undefined
  if (command) event.commands = [command]
  return event
}

/** 抬起一个键的 CDP 事件。 */
export function buildKeyUpEvent(definition: BrowserKeyDefinition, held: ReadonlySet<string>): BrowserPageDriverKeyEvent {
  const event: BrowserPageDriverKeyEvent = {
    type: 'keyUp',
    key: held.has('Shift') && definition.shifted ? definition.shifted : definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    modifiers: modifiersMask(held),
  }
  if (definition.location) event.location = definition.location
  return event
}
