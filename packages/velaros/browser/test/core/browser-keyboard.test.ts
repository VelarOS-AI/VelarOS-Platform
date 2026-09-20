// 用途：钉住键位表拼出的 CDP 键盘事件——Enter 带 \r 才会提交表单，Shift 按着时字母大写，
// Control、Meta 按着时不上屏，macOS 上 Meta 加 a 带 selectAll 命令；认不出的键名当场拒绝。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { buildKeyDownEvent, buildKeyUpEvent, isKnownKeyName, modifiersMask, resolveKeyDefinition } from '../../utils/keyboard.js'

/** 认一个键，认不出来就让用例失败。 */
function key(name: string) {
  const definition = resolveKeyDefinition(name)
  assert.ok(definition, `应当认得 ${name}`)
  return definition
}

void describe('键位表', () => {
  void test('Enter 按下时上屏 \\r、keyCode 13；Tab、Escape 这类不出字的键用 rawKeyDown', () => {
    const enter = buildKeyDownEvent(key('Enter'), new Set(), false)
    assert.deepEqual(
      { type: enter.type, key: enter.key, code: enter.code, keyCode: enter.windowsVirtualKeyCode, text: enter.text },
      { type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }
    )
    const tab = buildKeyDownEvent(key('Tab'), new Set(), false)
    assert.equal(tab.type, 'rawKeyDown')
    assert.equal(tab.text, undefined)
  })

  void test('别名与大小写都认：return、esc、up、space、cmd', () => {
    assert.equal(key('return').key, 'Enter')
    assert.equal(key('ESC').key, 'Escape')
    assert.equal(key('up').key, 'ArrowUp')
    assert.equal(key('space').key, ' ')
    assert.equal(key('cmd').key, 'Meta')
  })

  void test('Shift 按着时字母大写、修饰键位掩码带上；Control 按着时不上屏', () => {
    const shifted = buildKeyDownEvent(key('a'), new Set(['Shift']), false)
    assert.equal(shifted.key, 'A')
    assert.equal(shifted.text, 'A')
    assert.equal(shifted.modifiers, 8)
    const withControl = buildKeyDownEvent(key('a'), new Set(['Control']), false)
    assert.equal(withControl.type, 'rawKeyDown')
    assert.equal(withControl.text, undefined)
    assert.equal(withControl.modifiers, 2)
    assert.equal(modifiersMask(['Alt', 'Control', 'Meta', 'Shift']), 15)
  })

  void test('macOS 上 Meta 加 a 带 selectAll；别的平台不带命令', () => {
    assert.deepEqual(buildKeyDownEvent(key('a'), new Set(['Meta']), true).commands, ['selectAll'])
    assert.equal(buildKeyDownEvent(key('a'), new Set(['Meta']), false).commands, undefined)
  })

  void test('标点、数字与没有键位的字符：按美式键盘的 code，中文只上屏', () => {
    assert.deepEqual([key('?').code, key('?').keyCode], ['Slash', 191])
    assert.deepEqual([key('7').code, key('7').keyCode], ['Digit7', 55])
    const chinese = buildKeyDownEvent(key('中'), new Set(), false)
    assert.deepEqual([chinese.code, chinese.windowsVirtualKeyCode, chinese.text], ['', 0, '中'])
  })

  void test('修饰键抬起的事件按左边的键位；认不出的键名与组合键里的主键一起核对', () => {
    const shiftUp = buildKeyUpEvent(key('Shift'), new Set())
    assert.deepEqual([shiftUp.type, shiftUp.code, shiftUp.location], ['keyUp', 'ShiftLeft', 1])
    assert.equal(isKnownKeyName('Control+a'), true)
    assert.equal(isKnownKeyName('Hyper'), false)
    assert.equal(isKnownKeyName('Control+Hyper'), false)
  })
})
