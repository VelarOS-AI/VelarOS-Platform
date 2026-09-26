/**
 * `velaros:computer` 的入参核对：入参来自模型的程序，程序只查过语法、不查类型，这里拦——坐标是不是整数、在不在界内、两种坐标写法混用、
 * snapshotId 的样子、按键与连击次数、文字与按键串的长度，以及错形状。不合法当场拒绝（`VALIDATION`），一步都不做。
 */

import {
  isEmpty,
  isNonBlankString,
  isNumber,
  isPlainObject,
  isString,
  isUndefined,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ComputerInputLimits } from '../contract/constants.js'
import type {
  ComputerClickInput,
  ComputerKeyInput,
  ComputerPoint,
  ComputerTypeInput,
} from '../types/computer.js'

/** 截图交回的 snapshotId 的样子：字母、数字、下划线、连字符。 */
const SnapshotIdPattern = /^[A-Za-z0-9_-]+$/

/** 点击认的三个按键。 */
const ClickButtons = ['left', 'right', 'middle'] as const

/** 入参不合法：说清是哪个字段、要什么。 */
function invalid(message: string): AppError {
  return new AppError('VALIDATION', message)
}

/** 入参本身得是个对象。 */
function objectOf(input: unknown, operation: string): Record<string, unknown> {
  if (!isPlainObject(input))
    throw invalid(`${operation} 要一个对象作入参，这里给的是 ${JSON.stringify(input)}`)
  return input
}

/** 一个坐标分量：整数，在 [min, 坐标上限] 之内。 */
function coordinate(value: unknown, field: string, min: number): number {
  if (
    !isNumber(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > ComputerInputLimits.coordinateBound
  ) {
    throw invalid(
      `${field} 要 ${min}–${ComputerInputLimits.coordinateBound} 之间的整数，这里给的是 ${JSON.stringify(value)}`
    )
  }
  return value
}

/** 截图交回的 snapshotId：没给就是没按截图量坐标，给错了是改过或拼出来的。 */
function snapshotId(value: unknown, action: string): string {
  if (isUndefined(value)) {
    throw invalid(
      `按截图坐标${action}要带上同一次 screenshot 交回的 snapshotId；还没截图就先 screenshot，要用全局坐标就写 coordinateSpace: 'global'`
    )
  }
  if (
    !isString(value) ||
    value.length < ComputerInputLimits.snapshotIdMinChars ||
    value.length > ComputerInputLimits.snapshotIdMaxChars ||
    !SnapshotIdPattern.test(value)
  ) {
    throw invalid(`snapshotId 要原样用 screenshot 交回的那个，这里给的是 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 一个坐标：按截图量的要带 snapshotId、坐标不为负；全局坐标写 coordinateSpace: 'global'、不带 snapshotId，可以为负。
 * 两种写法混着给当场拒绝，不猜、不降级。
 */
export function pointInput(input: unknown, action: string): ComputerPoint {
  const value = objectOf(input, action)
  if (value.coordinateSpace === 'global') {
    if (!isUndefined(value.snapshotId))
      throw invalid(`全局坐标不带 snapshotId；要按截图坐标${action}就把 coordinateSpace 去掉`)
    const bound = -ComputerInputLimits.coordinateBound
    return {
      x: coordinate(value.x, 'x', bound),
      y: coordinate(value.y, 'y', bound),
      coordinateSpace: 'global',
    }
  }
  if (!isUndefined(value.coordinateSpace) && value.coordinateSpace !== 'primary-display') {
    throw invalid(
      `coordinateSpace 只收 'primary-display'（按截图量的坐标，缺省就是它）或 'global'，这里给的是 ${JSON.stringify(value.coordinateSpace)}`
    )
  }
  return {
    x: coordinate(value.x, 'x', 0),
    y: coordinate(value.y, 'y', 0),
    snapshotId: snapshotId(value.snapshotId, action),
    coordinateSpace: 'primary-display',
  }
}

/** 点击：坐标同 pointInput，button 只收 left、right、middle，count 是 1 到连击上限的整数。 */
export function clickInput(input: unknown): ComputerClickInput {
  const point = pointInput(input, '点击')
  const value = input as Record<string, unknown>
  const click: ComputerClickInput = { ...point }
  if (!isUndefined(value.button)) {
    if (!ClickButtons.includes(value.button as (typeof ClickButtons)[number]))
      throw invalid(
        `button 只收 ${ClickButtons.join('、')}，这里给的是 ${JSON.stringify(value.button)}`
      )
    click.button = value.button as (typeof ClickButtons)[number]
  }
  if (!isUndefined(value.count)) {
    if (
      !isNumber(value.count) ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      value.count > ComputerInputLimits.clickCount
    ) {
      throw invalid(
        `count 要 1–${ComputerInputLimits.clickCount} 之间的整数（双击给 2），这里给的是 ${JSON.stringify(value.count)}`
      )
    }
    click.count = value.count
  }
  return click
}

/** 要输入的文字：非空，最多上限那么多字符。 */
export function typeInput(input: unknown): ComputerTypeInput {
  const value = objectOf(input, 'typeText')
  if (
    !isString(value.text) ||
    isEmpty(value.text) ||
    value.text.length > ComputerInputLimits.typeTextChars
  ) {
    throw invalid(
      `text 要 1–${ComputerInputLimits.typeTextChars} 个字符的文字，这里给的是 ${JSON.stringify(value.text)?.slice(0, 80)}`
    )
  }
  return { text: value.text }
}

/** 按键串：非空白，最多上限那么多字符。 */
export function keyInput(input: unknown): ComputerKeyInput {
  const value = objectOf(input, 'key')
  if (!isNonBlankString(value.keys) || value.keys.length > ComputerInputLimits.keyChordChars) {
    throw invalid(
      `keys 要一个键或用 + 连起来的组合键（enter、cmd+a），最多 ${ComputerInputLimits.keyChordChars} 个字符，这里给的是 ${JSON.stringify(value.keys)}`
    )
  }
  return { keys: value.keys }
}
