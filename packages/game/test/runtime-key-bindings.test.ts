import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  describeUnknownKeyBinding,
  describeUnknownScriptAction,
  GameSupportedKeyBindings,
  resolvePhaserKeyBinding,
} from '../src/runtime/phaser-projection'

/**
 * 直接读 Phaser 自己的 `KeyCodes.js`——它是一个没有任何 DOM 依赖的纯 CommonJS 常量表，
 * 所以能在 Node/bun 里 require 出来(整个 Phaser 立不起来，这一张表可以)。
 *
 * 走 `require.resolve('phaser/package.json')` 定位而不是写死相对路径，是为了不被
 * bun 的依赖提升位置绑架。
 */
function loadPhaserKeyCodes(): Readonly<Record<string, number>> {
  const require_ = createRequire(import.meta.url)
  const phaserRoot = path.dirname(require_.resolve('phaser/package.json'))
  return require_(
    path.join(phaserRoot, 'src/input/keyboard/keys/KeyCodes.js')
  ) as Readonly<Record<string, number>>
}

const PhaserKeyCodes = loadPhaserKeyCodes()

/**
 * 静默失败三号：键位归一成了 Phaser 键码表里**不存在**的名字。
 *
 * `addKey('ESCAPE')` 不抛错——它拿 `KeyCodes['ESCAPE'] === undefined` 造出一个 keyCode 为
 * undefined 的 Key，那个 Key 永远 `isDown === false`。用户声明了键位、按下去毫无反应、
 * 日志干干净净。这一组把「整张表都对得上」和「对不上必须出声」两件事一起钉死。
 */
describe('phaser key binding table round-trips against the real Phaser KeyCodes', () => {
  test('the loaded KeyCodes table is the real one', () => {
    expect(Object.keys(PhaserKeyCodes).length).toBeGreaterThan(90)
    expect(PhaserKeyCodes.ESC).toBe(27)
  })

  test('every declarable binding resolves to a name that actually exists in Phaser', () => {
    expect(GameSupportedKeyBindings.length).toBeGreaterThan(90)
    const broken: string[] = []
    for (const code of GameSupportedKeyBindings) {
      const resolved = resolvePhaserKeyBinding(code)
      if (!resolved) {
        broken.push(`${code} -> 无法归一`)
        continue
      }
      const actual = PhaserKeyCodes[resolved.phaserKey]
      if (actual === undefined) {
        broken.push(`${code} -> KeyCodes.${resolved.phaserKey} 不存在(会造出恒 false 的空 Key)`)
        continue
      }
      // 派发侧与查表侧必须是同一个数，否则合成事件永远送不到那个 Key 上。
      if (actual !== resolved.keyCode) {
        broken.push(`${code} -> keyCode ${resolved.keyCode} ≠ KeyCodes.${resolved.phaserKey}=${actual}`)
      }
    }
    expect(broken).toEqual([])
  })

  test('the codes that were silently dead before the fix now map to the real names', () => {
    const expected: Readonly<Record<string, readonly [string, number]>> = {
      // 修前:'1' / 'ESCAPE' / 'CONTROL'——三个都不在表里。
      Digit1: ['ONE', 49],
      Digit0: ['ZERO', 48],
      Escape: ['ESC', 27],
      ControlLeft: ['CTRL', 17],
      ControlRight: ['CTRL', 17],
      // 修前 `(?:Left|Right)$` 那一刀把 BracketLeft/BracketRight 都削成了 'BRACKET'。
      BracketLeft: ['OPEN_BRACKET', 219],
      BracketRight: ['CLOSED_BRACKET', 221],
      PageUp: ['PAGE_UP', 33],
      PageDown: ['PAGE_DOWN', 34],
      CapsLock: ['CAPS_LOCK', 20],
      PrintScreen: ['PRINT_SCREEN', 42],
      Numpad0: ['NUMPAD_ZERO', 96],
      Numpad9: ['NUMPAD_NINE', 105],
      NumpadAdd: ['NUMPAD_ADD', 107],
      NumpadSubtract: ['NUMPAD_SUBTRACT', 109],
      Slash: ['FORWARD_SLASH', 191],
      Backslash: ['BACK_SLASH', 220],
      Quote: ['QUOTES', 222],
      Backquote: ['BACKTICK', 192],
      Equal: ['PLUS', 187],
    }
    for (const [code, [phaserKey, keyCode]] of Object.entries(expected)) {
      const resolved = resolvePhaserKeyBinding(code)
      expect(resolved).not.toBeNull()
      expect([code, resolved?.phaserKey, resolved?.keyCode]).toEqual([code, phaserKey, keyCode])
    }
  })

  test('the names the broken normalizer used to produce really are absent from Phaser', () => {
    // 这条是「为什么修前是静默的」的机械证据,顺便挡住「往 Phaser 里补个 ESCAPE 别名」式的假修。
    for (const dead of ['1', '0', 'ESCAPE', 'CONTROL', 'BRACKET', 'PAGEUP', 'NUMPAD0', 'META']) {
      expect(PhaserKeyCodes[dead]).toBeUndefined()
    }
  })

  test('the families that were already correct did not regress', () => {
    expect(resolvePhaserKeyBinding('KeyA')?.phaserKey).toBe('A')
    expect(resolvePhaserKeyBinding('KeyZ')?.keyCode).toBe(90)
    expect(resolvePhaserKeyBinding('ArrowLeft')?.phaserKey).toBe('LEFT')
    expect(resolvePhaserKeyBinding('ArrowUp')?.keyCode).toBe(38)
    expect(resolvePhaserKeyBinding('Space')?.phaserKey).toBe('SPACE')
    expect(resolvePhaserKeyBinding('Space')?.key).toBe(' ')
    expect(resolvePhaserKeyBinding('Enter')?.phaserKey).toBe('ENTER')
    expect(resolvePhaserKeyBinding('Tab')?.phaserKey).toBe('TAB')
    expect(resolvePhaserKeyBinding('ShiftLeft')?.phaserKey).toBe('SHIFT')
    expect(resolvePhaserKeyBinding('F5')?.keyCode).toBe(116)
  })

  test('unambiguous spellings are accepted without a round trip', () => {
    expect(resolvePhaserKeyBinding('space')?.phaserKey).toBe('SPACE')
    expect(resolvePhaserKeyBinding('SPACE')?.phaserKey).toBe('SPACE')
    expect(resolvePhaserKeyBinding('esc')?.phaserKey).toBe('ESC')
    expect(resolvePhaserKeyBinding('CTRL')?.phaserKey).toBe('CTRL')
    expect(resolvePhaserKeyBinding('a')?.phaserKey).toBe('A')
    expect(resolvePhaserKeyBinding('1')?.phaserKey).toBe('ONE')
    expect(resolvePhaserKeyBinding('LEFT')?.phaserKey).toBe('LEFT')
    // 宽容不等于乱猜:认不出来仍然是 null,由调用方出声。
    expect(resolvePhaserKeyBinding('MoveLeft')).toBeNull()
    expect(resolvePhaserKeyBinding('')).toBeNull()
  })
})

describe('an unresolvable key binding is reported, not silently turned into a dead Key', () => {
  test('the diagnostic names the culprit and explains why nothing happens', () => {
    const message = describeUnknownKeyBinding('输入动作 move_left', 'Ctrl')

    expect(message).toContain('move_left')
    expect(message).toContain('Ctrl')
    // 必须点破因果,否则读到的人只会以为是自己脚本写错了。
    expect(message).toContain('isDown === false')
    expect(message).toContain('报错为空')
    // 必须给得出下一步怎么写。
    expect(message).toContain('ControlLeft')
  })

  test('a totally unknown spelling still explains the accepted shapes', () => {
    const message = describeUnknownKeyBinding('key_down 步骤', 'JumpButton')

    expect(message).toContain('JumpButton')
    expect(message).toContain('KeyA')
    expect(message).toContain('Digit0')
    expect(message).toContain('ArrowUp')
  })

  test('Meta / Command gets told the truth: Phaser has no such key at all', () => {
    expect(resolvePhaserKeyBinding('MetaLeft')).toBeNull()
    const message = describeUnknownKeyBinding('输入动作 pause', 'MetaLeft')
    expect(message).toContain('Meta')
    expect(message).toContain('换一个键')
  })
})

/** 同一族高一层：脚本问了一个清单里没有的动作名，返回值与「没按下」完全同形。 */
describe('a script asking for an undeclared action is reported', () => {
  test('the diagnostic names the typo, the entity, and what is actually declared', () => {
    const message = describeUnknownScriptAction('player', 'jmp', ['jump', 'move-left'])

    expect(message).toContain('player')
    expect(message).toContain('jmp')
    expect(message).toContain('永远返回 false')
    // 必须把真实动作表摆出来，否则模型只能继续猜。
    expect(message).toContain('jump')
    expect(message).toContain('move-left')
  })

  test('an empty action table says so instead of printing nothing', () => {
    expect(describeUnknownScriptAction('player', 'jump', [])).toContain('一个都没有')
  })
})
