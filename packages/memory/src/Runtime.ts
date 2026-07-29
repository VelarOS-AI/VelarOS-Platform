import { MemoryTreeDomain, MemoryTreeRepository } from './memory-tree'
import type { MemoryTreeRuntimeProviders } from './Types'

/**
 * 已发布的最小运行时契约。
 *
 * 该接口有意只保留 0.3.2 已公开的成员，使既有结构化实现继续可赋值。
 * 新代码通常直接使用 {@link DefaultMemoryRuntime}。
 */
export interface MemoryRuntime {
  readonly memoryDomainService: MemoryTreeDomain
}

/**
 * 一个宿主独占的长期记忆运行时。
 *
 * 数据库连接由宿主注入；运行时本身不读取进程全局配置，也不持有产品状态。
 */
export class DefaultMemoryRuntime implements MemoryRuntime {
  public readonly domain: MemoryTreeDomain
  public readonly memoryDomainService: MemoryTreeDomain

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
// eslint-disable-next-line no-redeclare -- TypeScript 需要保留同名类型契约与构造器值。
export const MemoryRuntime = DefaultMemoryRuntime

export function createMemoryRuntime(
  providers: MemoryTreeRuntimeProviders
): DefaultMemoryRuntime {
  return new DefaultMemoryRuntime(providers)
}
