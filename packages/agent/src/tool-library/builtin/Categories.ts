// 域：工具页目录的**门面**。tool_map / tool_read / tool_replace 三个控制工具的业务实现散在
// 本目录的四个 ToolSpace* 模块里，本文件只做一件事：把五个 op 收成一张派发表，并把
// `Categories.tool.ts` 需要的 schema 原样透出。没有业务逻辑，改业务不该改到这里。
//
// ## 模块地图（依赖自下而上，无环）
//  - `ToolSpaceActivation` —— 底座：页的唯一来源 + 「这张页怎么用起来」的激活指引/依赖建模。
//  - `ToolSpaceSearch` —— find 的打分引擎：加权命中、命中信号、页外检索文本索引。
//  - `ToolSpaceQueries` —— 三个只读 op：find / page / map。
//  - `ToolSpaceSkillRead` —— read op：读技能正文，唯一不碰工具页的 op。
//  - `ToolSpaceReplace` —— replace op：唯一会改会话状态的 op。
//
// ## 关键不变量
// `ToolSpaceOpHandlers` 用 `satisfies` 与 `toolSpaceSchema` 的判别联合对齐：schema 加了 op 而这里
// 没接，编译期就红。`runToolSpace` 里那次断言是判别联合到具体 handler 的窄化，TS 无法自证，
// 但上面的 `satisfies` 已经保证了逐 op 的入参类型正确。

import { type z } from 'zod'

import type { KernelToolContext as ToolContext } from '../KernelToolContext'

import {
  mapToolDiscoveryCards,
  pageToolDiscoveryCards,
  searchToolDiscoveryCards,
} from './ToolSpaceQueries'
import { replaceToolSpacePages } from './ToolSpaceReplace'
import { type toolSpaceSchema } from './ToolSpaceSchemas'
import { readRequestedSkillPages } from './ToolSpaceSkillRead'

export {
  parseToolSpaceQueryMethodInput,
  toolSpaceQueryMethodSchema,
  toolSpaceReadMethodSchema,
  toolSpaceReplaceMethodSchema,
  toolSpaceSchema,
} from './ToolSpaceSchemas'

const ToolSpaceOpHandlers = {
  find: searchToolDiscoveryCards,
  page: pageToolDiscoveryCards,
  map: mapToolDiscoveryCards,
  read: readRequestedSkillPages,
  replace: replaceToolSpacePages,
} satisfies {
  [K in z.output<typeof toolSpaceSchema>['op']]: (
    ctx: ToolContext,
    input: Extract<z.output<typeof toolSpaceSchema>, { op: K }>
  ) => unknown
}

export async function runToolSpace(ctx: ToolContext, input: z.output<typeof toolSpaceSchema>) {
  const handler = ToolSpaceOpHandlers[input.op] as (
    ctx: ToolContext,
    input: z.output<typeof toolSpaceSchema>,
  ) => unknown
  return handler(ctx, input)
}
