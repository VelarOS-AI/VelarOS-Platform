import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { BrowserControlCapability } from './Capabilities'
import { requireActiveBrowserSite } from './Context'
import { defineBrowserTool } from './Types'

/** 页面录屏：CDP screencast 帧流 → GIF 产物,点开即播。 */
const browserScreencast = defineBrowserTool<{
  action: 'start' | 'stop'
  maxWidth?: number
  everyNthFrame?: number
  name?: string
}>({
  name: 'browser_screencast',
  role: 'control',
  summary: '录制页面操作过程并合成 GIF（回放/取证/演示）。',
  suitable: ['用户要求录下操作过程，或需要给关键流程留可回放的操作证据。'],
  forbidden: ['静态页面截图用 browser_capture_screenshot；录屏只为过程。'],
  usage: [
    'action=start 开始录制 → 执行页面操作 → action=stop 合成 GIF 并返回路径。',
    '页面无变化不产生新帧；达到帧数上限会自动截断。',
  ],
  examples: [{ action: 'start' }, { action: 'stop', name: 'login-flow' }],
  notes: ['GIF 落盘 artifacts/recordings/，文件管理器/聊天里点开即播。'],
  schema: z
    .object({
      action: z.enum(['start', 'stop']).describe(
        parameterDescription({
          description: '录屏动作。',
          values: ['start：开始录制。', 'stop：停止并合成 GIF。'],
        })
      ),
      maxWidth: z.number().int().min(240).max(1600).optional().describe(
        parameterDescription({
          description: 'start 的帧最大宽度；默认 800，越大文件越大。',
        })
      ),
      everyNthFrame: z.number().int().min(1).max(10).optional().describe(
        parameterDescription({
          description: 'start 的抽帧间隔（每 N 帧取 1）；默认 2。',
        })
      ),
      name: z.string().min(1).max(60).optional().describe(
        parameterDescription({
          description: 'stop 的产物名；缺省按时间戳命名。',
        })
      ),
    })
    ,
  permissions: ['fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    if (args.action === 'start') return ctx.browser.startScreencast({
        maxWidth: args.maxWidth,
        everyNthFrame: args.everyNthFrame,
      })
    return ctx.browser.stopScreencast({ name: args.name })
  },
})

const browserScreencastTools = {
  browser_screencast: browserScreencast,
}
export { browserScreencastTools }
