/**
 * 记忆库：`MemoryStore` 与工厂 `createMemoryStore`，接口 `MemoryStoreApi` 在本文件的类上方。
 * 宿主给一个根目录；根下一个作用域一个目录。作用域字符串由产品层给，记忆不解释它，只按它隔离。
 */

import { isAbsolute, join } from 'node:path'

import { isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryStoreOptions } from '../contract/requires.js'
import type { MemoryScopeSummary } from '../types/memory.js'
import { readDirectoryNames, readTextIfExists } from '../utils/fs.js'
import {
  compareScopeSummaries,
  scopeDirectoryName,
  ScopeRecordFileName,
} from '../utils/scope-directory.js'

import type { MemoryScopeApi } from './MemoryScope.js'
import { MemoryScope } from './MemoryScope.js'

/** 记忆库：按作用域取出一份记忆，列出有记忆的作用域。 */
export interface MemoryStoreApi {
  /** 取一个作用域：之后的读写只落在它的目录里。作用域是产品层给的任意非空字符串，记忆不解释它，按字符串逐字区分。 */
  scope(scope: string): MemoryScopeApi
  /** 列出有记忆的作用域，给管理页用：作用域原串、条数、最近一次更新，最近更新的在前。 */
  listScopes(): Promise<MemoryScopeSummary[]>
}

export class MemoryStore implements MemoryStoreApi {
  constructor(private readonly root: string) {}

  public scope(scope: string): MemoryScopeApi {
    if (!scope.trim())
      throw new AppError('VALIDATION', '作用域是空的：产品层要给一个非空的作用域字符串')
    return new MemoryScope(scope, join(this.root, scopeDirectoryName(scope)))
  }

  public async listScopes(): Promise<MemoryScopeSummary[]> {
    const summaries = await Promise.all(
      (await readDirectoryNames(this.root)).map((name) => this.summarize(name))
    )
    return summaries.filter(isPresent).sort(compareScopeSummaries)
  }

  /** 一个作用域目录的概况：没有 `.scope` 的目录不是记忆库建的，一条记忆都没有的也不列。 */
  private async summarize(directoryName: string): Promise<Nullable<MemoryScopeSummary>> {
    const directory = join(this.root, directoryName)
    const scope = await readTextIfExists(join(directory, ScopeRecordFileName))
    if (!isPresent(scope)) return null
    const entries = await new MemoryScope(scope, directory).list()
    const latest = entries[0]
    return latest ? { scope, count: entries.length, updatedAt: latest.updatedAt } : null
  }
}

/** 造一个记忆库：root 是宿主给的根目录，要是绝对路径。 */
export function createMemoryStore(options: MemoryStoreOptions): MemoryStoreApi {
  if (!isAbsolute(options.root))
    throw new AppError('VALIDATION', `记忆的根目录要是绝对路径，现在是 ${options.root}`)
  return new MemoryStore(options.root)
}
