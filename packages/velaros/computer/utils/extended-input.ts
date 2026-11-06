/** 扩展桌面操作在进入 helper 前统一校验形状、预算与不透明身份。 */
import { isAbsolute } from 'node:path'

import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'

import { ComputerInputLimits } from '../contract/constants.js'
import type {
  ComputerDragInput,
  ComputerElementInput,
  ComputerElementValueInput,
  ComputerKeyStateInput,
  ComputerMouseDownInput,
  ComputerMouseUpInput,
  ComputerRecordInput,
  ComputerScrollInput,
  ComputerTreeInput,
  ComputerWindowInput,
} from '../types/computer.js'

import { pointInput } from './input.js'

const Identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const Button = z.enum(['left', 'right', 'middle']).optional()
const Point = z.unknown().transform((value) => pointInput(value, '操作'))
const Screenshot = z.object({ windowId: Identity.optional() }).strict()
const Window = z.object({ windowId: Identity }).strict()
const Element = z.object({ treeId: Identity, elementId: Identity }).strict()
const Scroll = z
  .object({
    at: Point,
    deltaX: z
      .number()
      .int()
      .min(-ComputerInputLimits.scrollTicks)
      .max(ComputerInputLimits.scrollTicks)
      .default(0),
    deltaY: z
      .number()
      .int()
      .min(-ComputerInputLimits.scrollTicks)
      .max(ComputerInputLimits.scrollTicks)
      .default(0),
  })
  .strict()
  .refine((value) => value.deltaX !== 0 || value.deltaY !== 0, '滚动至少有一个非零方向')
const Drag = z
  .object({
    from: Point,
    to: Point,
    button: Button,
    durationMs: z.number().int().min(100).max(ComputerInputLimits.dragDurationMs).default(500),
  })
  .strict()
const MouseDown = z.object({ at: Point, button: Button }).strict()
const MouseUp = z.object({ button: Button }).strict()
const KeyState = z.object({ key: z.string().regex(/^[a-zA-Z0-9_]{1,32}$/) }).strict()
const Tree = Window.extend({
  maxDepth: z.number().int().min(1).max(ComputerInputLimits.treeDepth).default(6),
  maxNodes: z.number().int().min(1).max(ComputerInputLimits.treeNodes).default(200),
})
const ElementValue = Element.extend({ value: z.string().max(ComputerInputLimits.typeTextChars) })
const Record = Screenshot.extend({
  path: z
    .string()
    .max(4096)
    .refine(
      (value) => isAbsolute(value) && !value.includes('\0') && /\.mp4$/i.test(value),
      'path 必须是绝对路径的 MP4 文件'
    ),
  durationMs: z.number().int().min(100).max(ComputerInputLimits.recordingDurationMs),
  fps: z.number().int().min(1).max(ComputerInputLimits.recordingFps).default(5),
})

/** 入口形状失败统一交回 VALIDATION，不泄漏 Zod 的内部异常类型。 */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new AppError('VALIDATION', result.error.message)
  return result.data
}

/** 校验窗口身份。 */
export function windowInput(input: unknown): ComputerWindowInput {
  return parse(Window, input)
}
/** 校验滚动位置与刻度。 */
export function scrollInput(input: unknown): ComputerScrollInput {
  return parse(Scroll, input)
}
/** 拖拽两端均经过现有的截图绑定校验。 */
export function dragInput(input: unknown): ComputerDragInput {
  return parse(Drag, input)
}
/** 校验按下的按钮及目标。 */
export function mouseDownInput(input: unknown): ComputerMouseDownInput {
  return parse(MouseDown, input)
}
/** 释放时不要求截图，防止布局变化阻止清理。 */
export function mouseUpInput(input: unknown): ComputerMouseUpInput {
  return parse(MouseUp, input)
}
/** 单键按住不接受组合键表达式。 */
export function keyStateInput(input: unknown): ComputerKeyStateInput {
  return parse(KeyState, input)
}
/** 控件树只允许有限深度与节点预算。 */
export function treeInput(input: unknown): ComputerTreeInput {
  return parse(Tree, input)
}
/** 语义操作必须携带同一棵树的两项身份。 */
export function elementInput(input: unknown): ComputerElementInput {
  return parse(Element, input)
}
/** 控件值不经过按键表达式解析。 */
export function elementValueInput(input: unknown): ComputerElementValueInput {
  return parse(ElementValue, input)
}
/** 录像只写明确路径的新文件。 */
export function recordInput(input: unknown): ComputerRecordInput {
  return parse(Record, input)
}
