/** 工具层与它们背后的执行类用到的工作类型：入参过滤、回执形状、会话内的门控状态。 */

/** 一个站点在本次会话里的登录门控状态；`origin` 解析失败时退化为整串 URL。 */
import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { DefineToolRuntimeSpecInput } from '@velaros-ai/agent/tool-contract'

import type { BrowserToolContext } from '../contract/requires.js'

export type DefineBrowserToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, BrowserToolContext, unknown, ToolPermission>,
  'category'
>

export type BrowserLoginGateOriginState = 'prompted' | 'approved' | 'declined'
