/**
 * 一个作用域里的记忆：`MemoryScope`，接口 `MemoryScopeApi` 在本文件的类上方。
 * 读写只落在这个作用域的目录里：一条记忆一个 `<id>.md`，目录第一次写入时才建，目录里的 `.scope` 原样记着作用域字符串。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { isPresent } from '@velaros-ai/core'

import type { MemoryScopePort } from '../contract/requires.js'
import type {
  MemoryEntry,
  MemoryIdInput,
  MemoryRemoved,
  MemorySaved,
  MemorySaveInput,
} from '../types/memory.js'
import {
  assertMemoryExpected,
  compareByRecency,
  memoryFileName,
  memoryIdOfFile,
  memoryRevision,
  parseMemoryFile,
  serializeMemoryFile,
} from '../utils/entry-file.js'
import {
  readDirectoryNames,
  readTextIfExists,
  removeFileIfExists,
  withMemoryWriteLock,
  writeFileAtomically,
  writeFileIfMissing,
} from '../utils/fs.js'
import { removeInput, saveInput } from '../utils/input.js'
import { ScopeRecordFileName } from '../utils/scope-directory.js'

/** 一个作用域里的条目读写端口。 */
export interface MemoryScopeApi extends MemoryScopePort {}

export class MemoryScope implements MemoryScopeApi {
  constructor(
    private readonly scope: string,
    private readonly directory: string
  ) {}

  public async list(signal?: AbortSignal): Promise<MemoryEntry[]> {
    signal?.throwIfAborted()
    const ids = (await readDirectoryNames(this.directory)).map(memoryIdOfFile).filter(isPresent)
    signal?.throwIfAborted()
    const entries = await Promise.all(ids.map((id) => this.read(id)))
    signal?.throwIfAborted()
    return entries.filter(isPresent).sort(compareByRecency)
  }

  public async save(input: MemorySaveInput, signal?: AbortSignal): Promise<MemorySaved> {
    signal?.throwIfAborted()
    const entry = saveInput(input)
    const path = join(this.directory, memoryFileName(entry.id))
    await mkdir(this.directory, { recursive: true })
    return withMemoryWriteLock(
      path,
      async () => {
        const previous = await readTextIfExists(path)
        assertMemoryExpected(previous, entry.expectedRevision)
        const current = isPresent(previous) ? parseMemoryFile(entry.id, previous) : null
        const tags = entry.tags ?? current?.tags ?? []
        signal?.throwIfAborted()
        await writeFileIfMissing(join(this.directory, ScopeRecordFileName), this.scope)
        const raw = serializeMemoryFile({ ...entry, tags }, new Date().toISOString())
        await writeFileAtomically(path, raw, signal)
        return { id: entry.id, created: !isPresent(previous), revision: memoryRevision(raw) }
      },
      signal
    )
  }

  public async remove(input: MemoryIdInput, signal?: AbortSignal): Promise<MemoryRemoved> {
    signal?.throwIfAborted()
    const { id, expectedRevision: expected } = removeInput(input)
    const path = join(this.directory, memoryFileName(id))
    if (!isPresent(await readTextIfExists(path))) {
      assertMemoryExpected(null, expected)
      return { removed: false }
    }
    return withMemoryWriteLock(
      path,
      async () => {
        const previous = await readTextIfExists(path)
        assertMemoryExpected(previous, expected)
        signal?.throwIfAborted()
        return { removed: await removeFileIfExists(path) }
      },
      signal
    )
  }

  /** 读一条当前格式的记忆；格式错误明确失败，文件被并发删除才忽略。 */
  private async read(id: string): Promise<Nullable<MemoryEntry>> {
    const path = join(this.directory, memoryFileName(id))
    const raw = await readTextIfExists(path)
    return isPresent(raw) ? parseMemoryFile(id, raw) : null
  }
}
