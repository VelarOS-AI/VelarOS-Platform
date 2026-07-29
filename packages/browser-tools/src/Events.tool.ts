import { z } from 'zod'

import type { BrowserPendingEventKind } from '@velaros-ai/browser-core'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { BrowserControlCapability, BrowserObserveCapability } from './Capabilities'
import { hasPendingBrowserEvent, requireActiveBrowserSite } from './Context'
import { waitForPendingEvent } from './PendingEvents'
import { defineBrowserTool } from './Types'

const browserListPendingEvents = defineBrowserTool<Record<string, never>>({
  name: 'browser_list_pending_events',
  role: 'inspect',
  summary: '列出当前页面待处理的阻塞事件。',
  suitable: [
    '需要确认是否有未处理的 JS 弹窗、下载或权限请求。',
    'browser_get_page_diagnostics 显示 pending 事件后进一步定位 eventId。',
  ],
  forbidden: ['不要用它代替具体的 handle 工具。'],
  usage: ['无需参数；返回 pending 数组。'],
  examples: [{}],
  notes: ['事件会在超时后自动回退到默认策略。'],
  schema: z.object({}),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => hasPendingBrowserEvent(ctx),
  isConcurrencySafe: () => true,
  execute: async (_args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.listPendingEvents()
  },
})

const browserWaitForPendingEvent = defineBrowserTool<{
  kind?: BrowserPendingEventKind
  timeoutMs?: number
}>({
  name: 'browser_wait_for_pending_event',
  role: 'inspect',
  summary: '等待当前页面出现待处理的浏览器阻塞事件。',
  suitable: [
    '点击下载、触发权限请求或弹窗后，需要等待 pending 事件出现。',
    '下载动作后等待 download 事件，再调用 browser_handle_download 接受或取消。',
  ],
  forbidden: ['不要用它处理事件；处理仍使用 browser_handle_dialog/browser_handle_download/browser_handle_permission。'],
  usage: ['默认 kind=download；可传 kind=dialog/download/permission 和 timeoutMs。'],
  examples: [{ kind: 'download', timeoutMs: 1000 }],
  notes: ['返回 event 后，再用对应 handle 工具处理 eventId。'],
  schema: z.object({
    kind: z.enum(['dialog', 'download', 'permission']).optional().describe(
      parameterDescription({
        description: '要等待的 pending 事件类型。',
        notes: ['默认 download。'],
      })
    ),
    timeoutMs: z.number().transform((value) => Math.min(60000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最长等待毫秒数。',
        notes: ['默认 5000。', '上限 60000,超出自动钳制。'],
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ kind = 'download', timeoutMs }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return waitForPendingEvent({
      kind,
      timeoutMs,
      abortSignal: ctx.abortSignal,
      listPendingEvents: () => ctx.browser.listPendingEvents(),
    })
  },
})

const browserHandleDialog = defineBrowserTool<{
  eventId?: string
  accept: boolean
  promptText?: string
}>({
  name: 'browser_handle_dialog',
  role: 'control',
  summary: '处理待处理的 JS 弹窗（alert/confirm/prompt）。',
  suitable: ['页面出现 alert、confirm 或 prompt 弹窗阻塞自动化。'],
  forbidden: ['不要在无 pending dialog 时调用。'],
  usage: ['accept=true 确认；accept=false 取消；prompt 可传 promptText。'],
  examples: [
    // 确认 alert/confirm
    { accept: true },
    // 取消/拒绝
    { accept: false },
    // 给 prompt 弹窗填值并确认
    { accept: true, promptText: 'VelarOS' },
  ],
  notes: ['可先调用 browser_list_pending_events 获取 eventId。'],
  schema: z.object({
    eventId: z.string().optional().describe(
      parameterDescription({
        description: '待处理事件 ID；省略时处理最早的一个 dialog。',
      })
    ),
    accept: z.boolean().describe(
      parameterDescription({
        description: 'true 确认，false 取消/拒绝。',
      })
    ),
    promptText: z.string().optional().describe(
      parameterDescription({
        description: 'prompt 弹窗的输入文本。',
        usage: ['仅 prompt 类型需要。'],
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => hasPendingBrowserEvent(ctx, 'dialog'),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.handleDialog(args)
  },
})

const browserHandleDownload = defineBrowserTool<{
  eventId?: string
  action: 'accept' | 'cancel'
  savePath?: string
}>({
  name: 'browser_handle_download',
  role: 'control',
  summary: '接受或取消待处理的页面下载。',
  suitable: ['页面触发文件下载并阻塞后续操作时。'],
  forbidden: ['accept 时不要省略 savePath。'],
  usage: ['action=accept 时传 savePath（浏览器工作区相对路径）；action=cancel 取消下载。'],
  examples: [{ action: 'accept', savePath: 'downloads/report.pdf' }],
  notes: ['savePath 必须位于当前 browser workspace 内。'],
  schema: z
    .object({
      eventId: z.string().optional().describe(
        parameterDescription({
          description: '待处理下载事件 ID；省略时处理最早的一个。',
        })
      ),
      action: z.enum(['accept', 'cancel']).describe(
        parameterDescription({
          description: 'accept 保存到 savePath；cancel 取消下载。',
        })
      ),
      savePath: z.string().optional().describe(
        parameterDescription({
          description: '保存路径（相对 browser workspace）。',
          usage: ['action=accept 时必填。'],
        })
      ),
    })
    .superRefine((input, issueCtx) => {
      if (input.action === 'accept' && !input.savePath?.trim()) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['savePath'],
          message: 'accept 下载必须提供 savePath。',
        })
      }
    }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => hasPendingBrowserEvent(ctx, 'download'),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.handleDownload(args)
  },
})

const browserHandlePermission = defineBrowserTool<{
  eventId?: string
  grant: boolean
}>({
  name: 'browser_handle_permission',
  role: 'control',
  summary: '允许或拒绝待处理的浏览器权限请求。',
  suitable: ['页面请求 geolocation、notifications、clipboard 等权限时。'],
  forbidden: ['不要对非 pending 权限随意调用。'],
  usage: ['grant=true 允许；grant=false 拒绝。'],
  examples: [{ grant: true }],
  notes: ['可先调用 browser_list_pending_events 查看 permission 详情。'],
  schema: z.object({
    eventId: z.string().optional().describe(
      parameterDescription({
        description: '待处理权限事件 ID；省略时处理最早的一个。',
      })
    ),
    grant: z.boolean().describe(
      parameterDescription({
        description: 'true 允许权限；false 拒绝。',
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => hasPendingBrowserEvent(ctx, 'permission'),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.handlePermission(args)
  },
})

const browserEventTools = {
  browser_list_pending_events: browserListPendingEvents,
  browser_wait_for_pending_event: browserWaitForPendingEvent,
  browser_handle_dialog: browserHandleDialog,
  browser_handle_download: browserHandleDownload,
  browser_handle_permission: browserHandlePermission,
}
export { browserEventTools }
