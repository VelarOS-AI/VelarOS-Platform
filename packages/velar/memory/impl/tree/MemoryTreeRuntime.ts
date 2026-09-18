/**
 * 记忆树 v1 的运行时组装：类 `MemoryTreeRuntime` 与工厂 `createMemoryRuntime`。
 * 接口 `MemoryTreeRuntimeApi` 写在本文件的类上方，`contract/provides.ts` 登记。
 */

import type { MemoryTreeRuntimeProviders } from '../../contract/requires.js'

import { MemoryTreeDomain, type MemoryTreeDomainApi } from './MemoryTreeDomain.js'
import { MemoryTreeRepository } from './MemoryTreeRepository.js'

/**
 * 一个宿主独占的长期记忆运行时：拿宿主给的数据库解析器组装出记忆树的门面。
 *
 * 经 `createMemoryRuntime` 取得；运行时本身不读进程全局配置，也不持有产品状态。
 */
export interface MemoryTreeRuntimeApi {
  /** 这个宿主的记忆树门面，整个运行时只有这一份，生命周期跟着运行时走。 */
  readonly memoryDomainService: MemoryTreeDomainApi
}

/** 见 {@link MemoryTreeRuntimeApi}。 */
export class MemoryTreeRuntime implements MemoryTreeRuntimeApi {
  public readonly memoryDomainService: MemoryTreeDomainApi

  constructor(providers: MemoryTreeRuntimeProviders) {
    this.memoryDomainService = new MemoryTreeDomain(
      new MemoryTreeRepository(providers.databaseProvider)
    )
  }
}

/** 按注入的数据库解析器造一份记忆树运行时；一个宿主一份。 */
export function createMemoryRuntime(
  providers: MemoryTreeRuntimeProviders
): MemoryTreeRuntimeApi {
  return new MemoryTreeRuntime(providers)
}
