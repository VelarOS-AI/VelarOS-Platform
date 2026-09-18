/**
 * 一个作用域里的记忆：`MemoryScope`，接口 `MemoryScopeApi` 在本文件的类上方。
 * 读写只落在这个作用域的目录里：一条记忆一个 `<id>.md`，目录第一次写入时才建，目录里的 `.scope` 原样记着作用域字符串。
 */

import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isPresent } from '@velaros-ai/core'

import type { MemoryScopePort } from '../contract/requires.js'
import type { MemoryEntry, MemoryIdInput, MemoryRemoved, MemorySaved, MemorySaveInput } from '../types/memory.js'
import { compareByRecency, memoryFileName, memoryIdOfFile, parseMemoryFile, serializeMemoryFile } from '../utils/entry-file.js'
import { fileExists, readDirectoryNames, removeFileIfExists, writeFileAtomically, writeFileIfMissing } from '../utils/fs.js'
import { renderMemoryIndex } from '../utils/index-text.js'
import { removeInput, saveInput } from '../utils/input.js'
import { ScopeRecordFileName } from '../utils/scope-directory.js'

/** 一个作用域：三个操作要的端口，外加会话开场的那段索引。 */
export interface MemoryScopeApi extends MemoryScopePort {
  /** 会话开场放进系统提示词的那段索引：按类别分组、一行一条，放不下的只报条数，末尾列出现有标签。宿主在会话开始时调一次，整场不变。 */
  renderIndex(): Promise<string>
}

export class MemoryScope implements MemoryScopeApi {
  constructor(
    private readonly scope: string,
    private readonly directory: string,
  ) {}

  public async list(): Promise<MemoryEntry[]> {
    const ids = (await readDirectoryNames(this.directory)).map(memoryIdOfFile).filter(isPresent)
    const entries = await Promise.all(ids.map((id) => this.read(id)))
    return entries.sort(compareByRecency)
  }

  public async save(input: MemorySaveInput): Promise<MemorySaved> {
    const entry = saveInput(input)
    const path = join(this.directory, memoryFileName(entry.id))
    const existed = await fileExists(path)
    await mkdir(this.directory, { recursive: true })
    await writeFileIfMissing(join(this.directory, ScopeRecordFileName), this.scope)
    await writeFileAtomically(path, serializeMemoryFile(entry, new Date().toISOString()))
    return { id: entry.id, created: !existed }
  }

  public async remove(input: MemoryIdInput): Promise<MemoryRemoved> {
    const id = removeInput(input)
    return { removed: await removeFileIfExists(join(this.directory, memoryFileName(id))) }
  }

  public async renderIndex(): Promise<string> {
    return renderMemoryIndex(await this.list())
  }

  /** 读一条：文件内容加修改时间（头部没有能用的更新时间时拿它顶上）。 */
  private async read(id: string): Promise<MemoryEntry> {
    const path = join(this.directory, memoryFileName(id))
    const [raw, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return parseMemoryFile(id, raw, stats.mtime)
  }
}
