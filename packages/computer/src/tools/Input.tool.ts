import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'

import { ComputerControlCapability } from './Capabilities'
import { requireComputerAvailable } from './Context'
import { defineComputerTool } from './Types'

/** Move the cursor to a coordinate without clicking. */
const computerMove = defineComputerTool<{ x: number; y: number }>({
  name: 'computer:move',
  role: 'control',
  summary: '移动鼠标到屏幕坐标（不点击）。',
  suitable: ['需要悬停某处但不点击。'],
  forbidden: ['点击用 computer:click。'],
  usage: ['传屏幕逻辑坐标 x、y。'],
  examples: [{ x: 640, y: 400 }],
  notes: ['启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。'],
  schema: z.object({
    x: z
      .number()
      .int()
      .min(0)
      .max(20000)
      .describe(parameterDescription({ description: '屏幕逻辑 x 坐标。' })),
    y: z
      .number()
      .int()
      .min(0)
      .max(20000)
      .describe(parameterDescription({ description: '屏幕逻辑 y 坐标。' })),
  }),
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async ({ x, y }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    return ctx.computer.mouseMove(x, y)
  },
})

/** Click at a coordinate (button + count configurable). */
const computerClick = defineComputerTool<{
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  count?: number
}>({
  name: 'computer:click',
  role: 'control',
  summary: '在屏幕坐标点击桌面或原生应用。',
  suitable: ['点击桌面按钮、菜单、输入框等元素。'],
  forbidden: ['网页内点击用 browser 工具；未截图确认坐标不要盲点。'],
  usage: ['传 x、y；可选 button 和 count（双击传 2）。'],
  examples: [{ x: 756, y: 342 }],
  notes: ['启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。'],
  schema: z.object({
    x: z
      .number()
      .int()
      .min(0)
      .max(20000)
      .describe(parameterDescription({ description: '屏幕逻辑 x 坐标。' })),
    y: z
      .number()
      .int()
      .min(0)
      .max(20000)
      .describe(parameterDescription({ description: '屏幕逻辑 y 坐标。' })),
    button: z
      .enum(['left', 'right', 'middle'])
      .optional()
      .describe(parameterDescription({ description: '鼠标按键，默认 left。' })),
    count: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe(parameterDescription({ description: '点击次数，双击传 2。默认 1。' })),
  }),
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async ({ x, y, button, count }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    return ctx.computer.click(x, y, { button, count })
  },
})

/** Type literal text into the focused element. */
const computerType = defineComputerTool<{ text: string }>({
  name: 'computer:type',
  role: 'control',
  summary: '在当前焦点处输入文本。',
  suitable: ['向已聚焦的输入框/编辑器输入文字。'],
  forbidden: ['组合键用 computer:key。'],
  usage: ['先点击获取焦点，再传 text。'],
  examples: [{ text: 'hello world' }],
  notes: ['启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。'],
  schema: z.object({
    text: z
      .string()
      .min(1)
      .max(10000)
      .describe(parameterDescription({ description: '要输入的文本。' })),
  }),
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async ({ text }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    return ctx.computer.typeText(text)
  },
})

/** Press a key or key combination (e.g. "cmd+a", "enter"). */
const computerKey = defineComputerTool<{ keys: string }>({
  name: 'computer:key',
  role: 'control',
  summary: '按下按键或组合键。',
  suitable: ['发送 Enter、Esc、Tab 或 cmd/ctrl 快捷键。'],
  forbidden: ['普通文本用 computer:type。'],
  usage: ['传按键序列，用 + 连接。'],
  examples: [{ keys: 'enter' }, { keys: 'cmd+a' }],
  notes: ['启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。'],
  schema: z.object({
    keys: z
      .string()
      .min(1)
      .max(100)
      .describe(
        parameterDescription({
          description: '按键序列，组合键用 + 连接。',
          usage: ['示例：enter、esc、tab、cmd+a、ctrl+c。'],
        })
      ),
  }),
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async ({ keys }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    return ctx.computer.key(keys)
  },
})

const computerInputTools = {
  'computer:move': computerMove,
  'computer:click': computerClick,
  'computer:type': computerType,
  'computer:key': computerKey,
}
export { computerInputTools }
