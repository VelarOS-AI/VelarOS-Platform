import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { isPresent, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ComputerCoordinateSpace } from '../runtime'

import { ComputerControlCapability } from './Capabilities'
import { requireComputerAvailable } from './Context'
import { type ComputerToolContext, defineComputerTool } from './Types'

export interface ComputerPointInput extends Record<string, unknown> {
  x: number
  y: number
  coordinateSpace?: ComputerCoordinateSpace
}

interface ComputerClickModifiers {
  button?: 'left' | 'right' | 'middle'
  count?: number
}

export type ComputerClickInput = Record<string, unknown> & {
  x: number
  y: number
} & ComputerClickModifiers & (
  | {
      coordinateSpace?: 'primary-display'
      snapshotId: string
    }
  | {
      coordinateSpace: 'global'
      snapshotId?: never
    }
)

interface ResolvedComputerPoint {
  x: number
  y: number
  localX: number
  localY: number
  coordinateSpace: ComputerCoordinateSpace
  displayId?: number
  snapshotId?: string
}

const primaryDisplayPointShape = {
  x: z.number().int().min(0).max(20_000).describe(
    parameterDescription({ description: '主屏截图内的逻辑 x 坐标。' })
  ),
  y: z.number().int().min(0).max(20_000).describe(
    parameterDescription({ description: '主屏截图内的逻辑 y 坐标。' })
  ),
  coordinateSpace: z.literal('primary-display').default('primary-display').describe(
    parameterDescription({
      description: '默认 primary-display：坐标相对 computer:screenshot 左上角。',
    })
  ),
}

const globalPointShape = {
  x: z.number().int().min(-20_000).max(20_000).describe(
    parameterDescription({ description: '虚拟桌面的全局逻辑 x 坐标，可为负数。' })
  ),
  y: z.number().int().min(-20_000).max(20_000).describe(
    parameterDescription({ description: '虚拟桌面的全局逻辑 y 坐标，可为负数。' })
  ),
  coordinateSpace: z.literal('global').describe(
    parameterDescription({ description: '显式全局虚拟桌面坐标。' })
  ),
}

const snapshotIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe(
    parameterDescription({
      description: 'computer:screenshot 返回的不透明 snapshotId；必须原样传回。',
    })
  )

const computerPointSchema = z.union([
  z.object(primaryDisplayPointShape),
  z.object(globalPointShape),
])

async function resolveComputerPoint(
  input: ComputerPointInput,
  ctx: ComputerToolContext
): Promise<ResolvedComputerPoint> {
  if (input.coordinateSpace === 'global')
    return {
      x: input.x,
      y: input.y,
      localX: input.x,
      localY: input.y,
      coordinateSpace: 'global',
    }

  const display = await ctx.computer.screenSize()
  ctx.abortSignal.throwIfAborted()
  if (input.x >= display.width || input.y >= display.height) {
    throw new AppError(
      'VALIDATION',
      `主屏局部坐标超出截图边界：(${input.x}, ${input.y})，有效范围是 x=0-${display.width - 1}、y=0-${display.height - 1}。请重新截图定位。`
    )
  }

  return {
    x: display.originX + input.x,
    y: display.originY + input.y,
    localX: input.x,
    localY: input.y,
    coordinateSpace: 'primary-display',
    displayId: display.displayId,
  }
}

function projectComputerPointResult<TResult extends object>(
  result: TResult,
  point: ResolvedComputerPoint
) {
  return {
    ...result,
    x: point.localX,
    y: point.localY,
    coordinateSpace: point.coordinateSpace,
    globalX: point.x,
    globalY: point.y,
    displayId: optionalWhen(isPresent, point.displayId),
    snapshotId: optionalWhen(isPresent, point.snapshotId),
  }
}

/** 将光标移动到指定坐标，不执行点击。 */
const computerMove = defineComputerTool<ComputerPointInput>({
  name: 'computer:move',
  role: 'control',
  summary: '移动鼠标到屏幕坐标（不点击）。',
  suitable: ['需要悬停某处但不点击。'],
  forbidden: ['点击用 computer:click。'],
  usage: ['截图定位传 x、y 即可；只有显式使用虚拟桌面全局坐标时传 coordinateSpace=global。'],
  examples: [{ x: 640, y: 400 }],
  notes: ['启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。'],
  schema: computerPointSchema,
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    const point = await resolveComputerPoint(input, ctx)
    const result = await ctx.computer.mouseMove(point.x, point.y)
    return projectComputerPointResult(result, point)
  },
})

/** 在指定坐标点击，可配置鼠标按键与点击次数。 */
const computerClick = defineComputerTool<ComputerClickInput>({
  name: 'computer:click',
  role: 'control',
  summary: '在屏幕坐标点击桌面或原生应用。',
  suitable: ['点击桌面按钮、菜单、输入框等元素。'],
  forbidden: ['网页内点击用 browser 工具；不要省略或复用其他截图的 snapshotId。'],
  usage: [
    '点击截图内位置：传 x、y 和同一次 computer:screenshot 返回的 snapshotId。',
    '可选 button 和 count（双击传 2）；显式全局坐标传 coordinateSpace=global，且不要传 snapshotId。',
  ],
  examples: [{ x: 756, y: 342, snapshotId: 'screen_example_snapshot_01' }],
  notes: [
    'helper 会在真实点击前校验截图绑定；主屏或布局变化后旧 snapshotId 会被拒绝，请重新截图。',
    '启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。',
  ],
  schema: z.union([
    z.object({
      ...primaryDisplayPointShape,
      snapshotId: snapshotIdSchema,
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
    }).strict(),
    z.object({
      ...globalPointShape,
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
    }).strict(),
  ]),
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)

    if (input.coordinateSpace === 'global') {
      const result = await ctx.computer.click(input.x, input.y, {
        button: input.button,
        count: input.count,
        coordinateSpace: 'global',
      })
      return projectComputerPointResult(result, {
        x: result.x,
        y: result.y,
        localX: input.x,
        localY: input.y,
        coordinateSpace: 'global',
      })
    }

    if (!input.snapshotId)
      throw new AppError(
        'VALIDATION',
        '主屏截图坐标点击必须携带 computer:screenshot 返回的 snapshotId。请重新截图定位。'
      )

    const result = await ctx.computer.click(input.x, input.y, {
      button: input.button,
      count: input.count,
      coordinateSpace: 'primary-display',
      snapshotId: input.snapshotId,
    })
    return projectComputerPointResult(result, {
      x: result.x,
      y: result.y,
      localX: input.x,
      localY: input.y,
      coordinateSpace: 'primary-display',
      displayId: result.displayId,
      snapshotId: input.snapshotId,
    })
  },
})

/** 向当前聚焦元素输入原样文本。 */
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

/** 按下单键或组合键，例如 `cmd+a`、`enter`。 */
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
