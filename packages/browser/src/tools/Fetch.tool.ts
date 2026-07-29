import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { BrowserControlCapability, BrowserObserveCapability } from './Capabilities'
import { requireActiveBrowserSite } from './Context'
import { defineBrowserTool } from './Types'

const browserFetchResource = defineBrowserTool<{
  url: string
  savePath: string
  referer?: string
}>({
  name: 'browser_fetch_resource',
  role: 'control',
  summary: '用当前浏览器会话下载远程图片或视频到工作区。',
  suitable: [
    '已从页面拿到可直接访问的 http(s) 媒体 URL。',
    '需要保留登录态或站点 cookie 才能下载的资源。',
  ],
  forbidden: [
    '不要用于 blob:、data: 或 DRM 受保护流。',
    'savePath 必须位于当前 browser workspace 内。',
  ],
  usage: [
    '先用 browser_list_media_sources 或 browser_evaluate_script preset=media_sources 找 URL。',
    '传 url 和 savePath（建议 downloads/ 下）；需要时传 referer。',
  ],
  examples: [
    {
      url: 'https://example.com/assets/hero.jpg',
      savePath: 'downloads/hero.jpg',
    },
  ],
  notes: ['使用当前页面 session cookie；单文件上限 50MB。'],
  schema: z.object({
    url: z.string().url().max(4096).describe(
      parameterDescription({
        description: '要下载的 http(s) 资源 URL。',
      })
    ),
    savePath: z.string().min(1).max(4096).describe(
      parameterDescription({
        description: '保存路径（相对 browser workspace）。',
        usage: ['建议放在 downloads/ 目录。'],
      })
    ),
    referer: z.string().url().max(4096).optional().describe(
      parameterDescription({
        description: '可选 Referer；省略时使用当前页面 URL。',
      })
    ),
  }),
  permissions: ['network', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.fetchResource(args)
  },
})

const browserListMediaSources = defineBrowserTool<{
  limit?: number
  includeDataUrls?: boolean
  includeBlobUrls?: boolean
}>({
  name: 'browser_list_media_sources',
  role: 'inspect',
  summary: '列出当前页面上的图片、视频和音频 URL。',
  suitable: [
    '需要批量发现页面媒体资源再逐个下载。',
    'browser_inspect_page 未直接给出媒体 URL 时。',
  ],
  forbidden: ['不要指望枚举到跨域 iframe 内或 DRM 保护的媒体。'],
  usage: ['无需参数；按需调整 limit 或包含 data/blob URL。'],
  examples: [{ limit: 40 }],
  notes: ['fetchable=true 的 URL 可直接传给 browser_fetch_resource。'],
  schema: z.object({
    limit: z.number().transform((value) => Math.min(200, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最多返回多少条。',
        notes: ['默认 80。', '上限 200,超出自动钳制。'],
      })
    ),
    includeDataUrls: z.boolean().optional().describe(
      parameterDescription({
        description: '是否包含 data: URL。',
        notes: ['默认 false。'],
      })
    ),
    includeBlobUrls: z.boolean().optional().describe(
      parameterDescription({
        description: '是否包含 blob: URL。',
        notes: ['默认 false；blob URL 无法直接 fetch。'],
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.listMediaSources(args)
  },
})

const browserListPageResources = defineBrowserTool<{
  limit?: number
  includeIframes?: boolean
}>({
  name: 'browser_list_page_resources',
  role: 'inspect',
  summary: '枚举页面链接、iframe 与媒体资源概览。',
  suitable: [
    '需要盘点页面全部可见链接与嵌入资源。',
    '制定批量下载或提取计划前的资源清单。',
  ],
  forbidden: ['跨域 iframe 内部链接无法枚举。'],
  usage: ['无需参数；按需调整 limit 或 includeIframes。'],
  examples: [{ limit: 80, includeIframes: true }],
  notes: ['媒体详情用 browser_list_media_sources；fetchable URL 用 browser_fetch_resource。'],
  schema: z.object({
    limit: z.number().transform((value) => Math.min(500, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '链接/iframe 最多返回多少条。',
        notes: ['默认 120。', '上限 500,超出自动钳制。'],
      })
    ),
    includeIframes: z.boolean().optional().describe(
      parameterDescription({
        description: '是否包含 iframe 列表。',
        notes: ['默认 true。'],
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.listPageResources(args)
  },
})

const browserFetchTools = {
  browser_fetch_resource: browserFetchResource,
  browser_list_media_sources: browserListMediaSources,
  browser_list_page_resources: browserListPageResources,
}
export { browserFetchTools }
