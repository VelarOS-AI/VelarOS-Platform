import { toNullable } from '@velaros-ai/core'

import type { MemoryFilesIo } from '../../contract/requires'
import { normalizeMemoryFilePath } from '../../utils/files/entry-path'

/**
 * 纯内存的文件 IO：探针与 headless 宿主用，一个真实文件都不落。
 *
 * 目录以「存在过写入」隐式表达——权威层没有空目录语义，索引文件缺席就等于该作用域没记忆。
 * 实例由 `createInMemoryMemoryFilesIo` 造，每个实例各持一份自己的文件表。
 */
export interface InMemoryMemoryFilesIoApi extends MemoryFilesIo {
  /** 当前所有文件的快照（路径 → 内容，按路径排序），供探针断言。 */
  snapshot(): Readonly<Record<string, string>>
}

/** 纯内存的文件 IO 实现。 */
export class InMemoryMemoryFilesIo implements InMemoryMemoryFilesIoApi {
  /** 路径分隔符：内存实现一律用 `/`，平台差异不进这一层。 */
  private static readonly Separator = '/'

  private readonly files: Map<string, string>

  constructor(seed: Readonly<Record<string, string>> = {}) {
    this.files = new Map<string, string>(
      Object.entries(seed).map(([path, content]) => [normalizeMemoryFilePath(path), content]),
    )
  }

  public join(...segments: readonly string[]): string {
    return normalizeMemoryFilePath(
      segments.filter((segment) => segment.length > 0).join(InMemoryMemoryFilesIo.Separator),
    )
  }

  public ensureDirectory(): void {
    // 内存实现没有独立目录节点：写文件即建目录。
  }

  public listFiles(directory: string): readonly string[] {
    const prefix = `${normalizeMemoryFilePath(directory).replace(/\/$/u, '')}/`
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes(InMemoryMemoryFilesIo.Separator))
      .map((path) => path.slice(prefix.length))
      .sort()
  }

  public readTextFile(path: string): Nullable<string> {
    return toNullable(this.files.get(normalizeMemoryFilePath(path)))
  }

  public writeTextFile(path: string, content: string): void {
    this.files.set(normalizeMemoryFilePath(path), content)
  }

  public deleteFile(path: string): void {
    this.files.delete(normalizeMemoryFilePath(path))
  }

  public isInsideDirectory(path: string, root: string): boolean {
    // 内存实现没有符号链接：规整后按段比较即可，判据与 Node 实现同形。
    const base = normalizeMemoryFilePath(root).replace(/\/$/u, '')
    const target = normalizeMemoryFilePath(path)
    return target === base || target.startsWith(`${base}/`)
  }

  public snapshot(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.files.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
    )
  }
}

/** 造一份纯内存的文件 IO；`seed` 里的路径与内容作为初始文件表。 */
export function createInMemoryMemoryFilesIo(
  seed: Readonly<Record<string, string>> = {},
): InMemoryMemoryFilesIoApi {
  return new InMemoryMemoryFilesIo(seed)
}
