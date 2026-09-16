/**
 * 记忆树 v1 的运行时组装：`DefaultMemoryRuntime` 与工厂 `createMemoryRuntime`。
 * 接口 `MemoryRuntime` 在本文件的类上方；文件名与类名不一致是入口收口轮要改的旧账。
 */

import type { MemoryTreeRuntimeProviders } from '../../contract/requires'

import { MemoryTreeDomain, type MemoryTreeDomainApi } from './MemoryTreeDomain'
import { MemoryTreeRepository } from './MemoryTreeRepository'

/**
 * 一个宿主独占的长期记忆运行时：拿宿主给的数据库解析器组装出记忆树的门面。
 *
 * 实现是 `DefaultMemoryRuntime`，经 `createMemoryRuntime` 取得；运行时本身不读进程全局配置，也不持有产品状态。
 * 接口有意只保留已公开的成员，让既有的结构化实现继续可赋值。
 */
export interface MemoryRuntime {
  /** 这个宿主的记忆树门面，整个运行时只有这一份，生命周期跟着运行时走。 */
  readonly memoryDomainService: MemoryTreeDomainApi
  /** `memoryDomainService` 的旧名，指向同一个门面；入口收口轮会删掉它。 */
  readonly domain: MemoryTreeDomainApi
}

export class DefaultMemoryRuntime implements MemoryRuntime {
  public readonly domain: MemoryTreeDomainApi
  public readonly memoryDomainService: MemoryTreeDomainApi

  constructor(providers: MemoryTreeRuntimeProviders) {
    this.domain = new MemoryTreeDomain(
      new MemoryTreeRepository(providers.databaseProvider)
    )
    this.memoryDomainService = this.domain
  }
}

/**
 * 兼容的构造器入口：类型位置仍表示已发布的最小契约，值位置可用于创建和
 * `instanceof` 检查。需要声明具体实例类型时使用 {@link DefaultMemoryRuntime}。
 */
 
export const MemoryRuntime = DefaultMemoryRuntime

export function createMemoryRuntime(
  providers: MemoryTreeRuntimeProviders
): MemoryRuntime {
  return new DefaultMemoryRuntime(providers)
}
