/**
 * 有界高级搜索（`velaros:search`）的操作：`SearchOperations` 与整个进程唯一的 `searchOperations`。接口 `SearchOperationsApi` 在本文件的类上方。
 * 三个操作只查取消，再交给调用上下文里的搜索编排口；档位、来源、续查检查点与各项上限由编排口核对。
 */

import type { SearchOperationContext } from '../contract/requires.js'
import type { SearchProfileInfo, SearchReadInput, SearchReadResult, SearchRequest, SearchResult } from '../types.js'

/**
 * @AgentView
 * 有界高级搜索：另起一个只读的搜索模型，在已授权的来源里检索、读证据，交回发现、证据引用与缺口。
 * search 只能在 execute 里调用；read 读已发布的报告或刷新其中的证据，不调用模型，observe 里也能用。
 */
export interface SearchOperationsApi {
  /** @AgentView 列出能选的搜索档位、默认的那个与它们的全部资源上限。
   * @OperationEffect none
   */
  profiles(ctx: SearchOperationContext): Promise<SearchProfileInfo[]>
  /** @AgentView 新建或续查一项有界搜索，返回报告。
   * @OperationEffect none
   * @OperationModes execute
   */
  search(input: SearchRequest, ctx: SearchOperationContext): Promise<SearchResult>
  /** @AgentView 读已发布的报告：snapshot 读当时的原文，current 重读选中证据的现状。
   * @OperationEffect none
   */
  read(input: SearchReadInput, ctx: SearchOperationContext): Promise<SearchReadResult>
}

export class SearchOperations implements SearchOperationsApi {
  public async profiles(ctx: SearchOperationContext): Promise<SearchProfileInfo[]> {
    ctx.call.signal.throwIfAborted()
    return [...ctx.search.profileInfo()]
  }

  public async search(input: SearchRequest, ctx: SearchOperationContext): Promise<SearchResult> {
    ctx.call.signal.throwIfAborted()
    return ctx.search.run(input, ctx.call)
  }

  public async read(input: SearchReadInput, ctx: SearchOperationContext): Promise<SearchReadResult> {
    ctx.call.signal.throwIfAborted()
    return ctx.search.read(input, ctx.call)
  }
}

/** 整个进程只有一份的搜索操作；装配时把搜索编排口与这次 Kernel 调用塞进上下文。 */
export const searchOperations: SearchOperationsApi = new SearchOperations()
