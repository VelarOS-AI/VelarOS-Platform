import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import {
  BrowserArtifactReadCapability,
  BrowserControlCapability,
  BrowserObserveCapability,
  BrowserSessionCapability,
} from './Capabilities'
import { createArtifactManager, getActiveBrowserContext, requireActiveBrowserSite } from './Context'
import { defineBrowserTool } from './Types'

/** 进入或切换当前 session 的 browser site 工作区。 */
const enterBrowserSite = defineBrowserTool<{ url: string }>({
  name: 'browser:enter_site',
  role: 'control',
  summary: '打开网站并进入浏览器会话。',
  suitable: [
      '用户要求打开、访问、分析或操作某个网页。',
      '当前浏览器会话绑定的网站与目标网站不一致。',
    ],
  forbidden: [
      '不要在没有目标网站时调用。',
    ],
  protocol: [
      '先进入目标网站，再使用 inspect、query、click、screenshot 等浏览器工具。',
      '切换主站点时保留旧站点工作区，并为新站点创建独立工作区。',
    ],
  usage: ['传目标 URL；调用成功后后续 browser 工具绑定该站点。'],
  examples: [{ url: "http://localhost:3000" }],
  notes: ['浏览器工作区按站点隔离，不能跨站点直接读写。'],
  schema: z.object({
    url: z
      .string()
      .min(1)
      .describe(
        parameterDescription({
          description: '要绑定的目标网站 URL。',
          usage: ['支持 https://、http:// 和 localhost。'],
          notes: ['不带协议时默认补全 https://。'],
        })
      ),
  }),
  permissions: ['network', 'fs:write'],
  capabilities: BrowserSessionCapability,
  isConcurrencySafe: () => false,
  execute: async ({ url }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // enterSite 会打开页面、绑定当前 session，并准备站点级 context。
    const browserContext = await ctx.browser.enterSite(url)
    // 首次进入站点时确保 manifest 存在，后续 artifact 工具才能按标准目录写入。
    const workspaceManifest = await createArtifactManager(ctx).ensureManifest(browserContext)

    return {
      active: true,
      browserContext,
      workspaceManifest,
      message: '已打开并进入当前网站的浏览器会话；如果之前已绑定其他网站，则已同步切换。',
    }
  },
})

/** 退出当前 browser site 模式。 */
const leaveBrowserSite = defineBrowserTool<Record<string, never>>({
  name: 'browser:leave_site',
  role: 'control',
  summary: '退出当前浏览器网站会话。',
  suitable: ['不再需要当前网站的浏览器能力。'],
  forbidden: ['不要在仍需继续操作当前网页时调用。'],
  usage: ['调用时传空对象。'],
  examples: [{}],
  notes: ['退出不会删除该站点已有浏览器工作区产物。'],
  schema: z.object({}),
  permissions: [],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 只解除当前 session 的 browser mode，不删除站点工作区产物。
    await ctx.browser.leaveSite()

    return {
      active: false,
      message: '已退出当前浏览器网站工作区。',
    }
  },
})

/** 显示并连接当前受控浏览器页面。 */
const browserShowPage = defineBrowserTool<Record<string, never>>({
  name: 'browser:show_page',
  role: 'control',
  summary: '显示并连接当前受控浏览器页面。',
  suitable: ['需要让当前已绑定网页在内嵌浏览器中可见。'],
  forbidden: ['不要用它切换网站；切换网站用 browser:enter_site。'],
  usage: ['调用前必须已有 active browser site。'],
  examples: [{}],
  notes: ['只连接当前受控页面，不提供任意脚本执行。'],
  schema: z.object({}),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 即使 isAvailable 已判断一次，执行前仍校验，防止状态在调用间变化。
    requireActiveBrowserSite(ctx)

    return ctx.browser.showPage()
  },
})

/** 隐藏当前受控浏览器页面。 */
const browserHidePage = defineBrowserTool<Record<string, never>>({
  name: 'browser:hide_page',
  role: 'control',
  summary: '隐藏当前受控浏览器页面。',
  suitable: ['需要收起可视页面但保留站点会话。'],
  forbidden: ['不要用它退出 browser mode；退出用 browser:leave_site。'],
  usage: ['调用前必须已有 active browser site。'],
  examples: [{}],
  notes: ['隐藏后可用 browser:show_page 重新显示。'],
  schema: z.object({}),
  permissions: [],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // hidePage 保留 session，后续 showPage 可重新显示。
    requireActiveBrowserSite(ctx)

    return ctx.browser.hidePage()
  },
})

/** 读取当前 browser mode 状态和绑定站点信息。 */
const getBrowserSiteContext = defineBrowserTool<Record<string, never>>({
  name: 'browser:site_context',
  role: 'inspect',
  summary: '查看当前浏览器会话状态。',
  suitable: ['需要判断 browser mode 是否激活或查看绑定站点信息。'],
  forbidden: ['不要用它打开或切换网站。'],
  usage: ['可在 browser mode 未激活时调用。'],
  examples: [{}],
  notes: ['返回 active 和当前 browserContext。'],
  schema: z.object({}),
  permissions: [],
  capabilities: BrowserObserveCapability,
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => ({
    // 这个工具本身可在未激活时调用，用于探测状态。
    active: ctx.browser.isActive(),
    browserContext: ctx.browser.getContext(),
  }),
})

/** 枚举当前受控浏览器页面 target。 */
const browserListPageTargets = defineBrowserTool<Record<string, never>>({
  name: 'browser:list_page_targets',
  role: 'inspect',
  summary: '列出当前受控浏览器页面 target。',
  suitable: [
      '需要判断当前浏览器是内嵌 WebView 还是外部 CDP 页面。',
      '需要查看外部浏览器可见的 page target 列表，为后续多标签页控制做判断。',
    ],
  forbidden: [
      '不要用它切换、新建或关闭标签页；它只读当前 target 库存。',
    ],
  usage: ['调用前必须已有 active browser site；传空对象。'],
  examples: [{}],
  notes: ['WebView 路径返回单个 synthetic current target；外部 CDP 路径尽量读取真实 page target list。'],
  schema: z.object({}),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return ctx.browser.listPageTargets()
  },
})

/** 切换当前受控的外部 CDP 页面 target。 */
const browserSwitchPageTarget = defineBrowserTool<{ targetId: string }>({
  name: 'browser:switch_page_target',
  role: 'control',
  summary: '切换当前受控的外部 CDP page target。',
  suitable: [
      '外部浏览器已有多个 page target，需要把后续 browser 工具绑定到另一个标签页。',
      'browser:list_page_targets 返回了目标 targetId，且用户或任务需要操作该页面。',
    ],
  forbidden: [
      '不要用它切换网站工作区；主站点切换仍使用 browser:enter_site。',
      '不要在内嵌 WebView 路径使用；WebView 当前只有单个 synthetic target。',
    ],
  protocol: [
      '先调用 browser:list_page_targets 获取 targetId。',
      '切换后继续用 browser:inspect_page 或 browser:get_page_state 确认当前受控页面。',
    ],
  usage: ['传 browser:list_page_targets 返回的 targetId。'],
  examples: [{ targetId: 'page-2' }],
  notes: ['只切换当前受控 page driver，不关闭外部浏览器窗口。'],
  schema: z.object({
    targetId: z
      .string()
      .min(1)
      .describe(
        parameterDescription({
          description: '要切换到的 CDP page target id。',
          usage: ['来自 browser:list_page_targets 返回的 targets[].id。'],
        })
      ),
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ targetId }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return ctx.browser.switchPageTarget({ targetId })
  },
})

/** 读取或创建当前站点工作区 manifest。 */
const getBrowserWorkspaceManifest = defineBrowserTool<Record<string, never>>({
  name: 'browser:space_manifest',
  role: 'inspect',
  summary: '读取当前站点浏览器工作区清单。',
  suitable: ['需要确认站点工作区路径和标准 artifact 目录。'],
  forbidden: ['不要在 browser mode 未激活时调用。'],
  usage: ['调用前必须已有 active browser site。'],
  examples: [{}],
  notes: ['manifest 缺失时会被幂等创建。'],
  schema: z.object({}),
  permissions: ['fs:read', 'fs:write'],
  capabilities: BrowserArtifactReadCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // ensureManifest 是幂等操作，缺失时会补齐标准目录说明。
    return createArtifactManager(ctx).ensureManifest(getActiveBrowserContext(ctx))
  },
})

/** session 类 browser 工具出口。 */
const browserSessionTools = {
  'browser:enter_site': enterBrowserSite,
  'browser:leave_site': leaveBrowserSite,
  'browser:show_page': browserShowPage,
  'browser:hide_page': browserHidePage,
  'browser:site_context': getBrowserSiteContext,
  'browser:list_page_targets': browserListPageTargets,
  'browser:switch_page_target': browserSwitchPageTarget,
  'browser:space_manifest': getBrowserWorkspaceManifest,
}
export { browserSessionTools }
