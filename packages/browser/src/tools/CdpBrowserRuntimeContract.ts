import type { CdpBrowserRuntime } from '../core'

import type { ToolBrowserApi } from './Types'

/**
 * 编译型契约验证:`CdpBrowserRuntime.bindBrowserApi(sessionId, context)` 的返回面
 * 在结构上满足 `ToolBrowserApi`（`BrowserToolContext.browser` 全仓唯一权威契约）。
 *
 * CdpBrowserRuntime 不 import `ToolBrowserApi`（避免与 browser-tools 形成包环）,契约一致性
 * 由本文件在 browser-tools 侧强制:若 bindBrowserApi 的返回面缺方法或签名漂移,`EnsureToolBrowserApi`
 * 的约束 `T extends ToolBrowserApi` 会在此处编译报错。方向:browser-tools → browser-core（无环）。
 */
type CdpBoundBrowserApi = ReturnType<CdpBrowserRuntime['bindBrowserApi']>

type EnsureToolBrowserApi<T extends ToolBrowserApi> = T

export type CdpBoundBrowserApiSatisfiesToolBrowserApi = EnsureToolBrowserApi<CdpBoundBrowserApi>
