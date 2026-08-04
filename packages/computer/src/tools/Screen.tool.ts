import { z } from 'zod'

import { ComputerObserveCapability } from './Capabilities'
import { requireComputerAvailable } from './Context'
import { defineComputerTool } from './Types'

/** Capture the primary display so the model can visually locate UI elements. */
const computerScreenshot = defineComputerTool<Record<string, never>>({
  name: 'computer:screenshot',
  role: 'inspect',
  summary: '截取桌面主屏幕，用于定位原生应用 UI。',
  suitable: ['执行桌面点击/输入前确认界面并获取坐标。'],
  forbidden: ['网页内容用 browser 工具，不要用桌面截图替代。'],
  usage: ['无需参数。'],
  examples: [{}],
  notes: [
    '返回屏幕几何，并把截图作为图片直接呈现给模型（base64 不进文本，避免上下文膨胀）。',
    '截图为逻辑分辨率，width/height 即逻辑坐标系；图上量出的像素坐标可直接用于 computer:click。',
  ],
  schema: z.object({}),
  permissions: ['screen:capture'],
  capabilities: ComputerObserveCapability,
  requiredModelInputModalities: ['image'],
  isConcurrencySafe: () => true,
  execute: async (_args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    const { base64, format, ...geometry } = await ctx.computer.screenshot()
    // base64 不放进文本结果；executor 的 liftGenericModelImage 会把 modelImage 提升成模型可见图片。
    return {
      ...geometry,
      format,
      modelImage: { data: base64, mediaType: `image/${format}` as const },
    }
  },
})

/** Report the primary display's logical geometry. */
const computerScreenSize = defineComputerTool<Record<string, never>>({
  name: 'computer:screen_size',
  role: 'inspect',
  summary: '查询主屏幕逻辑尺寸与缩放。',
  suitable: ['点击前需要屏幕宽高、缩放或原点。'],
  forbidden: ['定位 UI 用 computer:screenshot，不要用它替代。'],
  usage: ['无需参数。'],
  examples: [{}],
  notes: ['返回逻辑宽高、scaleFactor 与原点。'],
  schema: z.object({}),
  permissions: ['screen:capture'],
  capabilities: ComputerObserveCapability,
  isConcurrencySafe: () => true,
  execute: async (_args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    await requireComputerAvailable(ctx)
    return ctx.computer.screenSize()
  },
})

const computerScreenTools = {
  'computer:screenshot': computerScreenshot,
  'computer:screen_size': computerScreenSize,
}
export { computerScreenTools }
