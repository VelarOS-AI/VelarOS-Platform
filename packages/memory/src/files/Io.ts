/**
 * `memory-files` 的文件系统端口。
 *
 * 包内**零宿主假设**：目录路径全部由宿主注入（全局面 = userData，项目面 = 仓根
 * `.velaros/memory/`，§九 9.5），文件读写本身也走这个窄端口——探针据此用纯内存实现直驱，
 * 不落一个真实文件；Node 宿主注入 `createNodeMemoryFilesIo()`（住 `./NodeIo`，本文件不碰 fs）。
 *
 * 端口刻意只有六个方法：拼路径、目录创建、列目录、读文本、写文本、删文件。
 * 没有 stat/watch/权限——权威层是「一堆 markdown」，多一个方法就多一条把后端绑死在
 * 某个文件系统语义上的绳子。
 */

export interface MemoryFilesIo {
  /** 拼接路径片段；平台差异由实现自持（Node 用 path.join，内存实现用 `/`）。 */
  join(...segments: readonly string[]): string
  /** 递归创建目录；已存在时静默成功。 */
  ensureDirectory(directory: string): void
  /** 列出目录下的**文件名**（非递归，不含子目录）；目录不存在时返回空数组。 */
  listFiles(directory: string): readonly string[]
  /** 读文本；文件不存在返回 null（不抛）。 */
  readTextFile(path: string): Nullable<string>
  /** 写文本；父目录缺失时自行创建。实现应尽量做到「写完即完整」。 */
  writeTextFile(path: string, content: string): void
  /** 删文件；不存在时静默成功。 */
  deleteFile(path: string): void
}

export interface InMemoryMemoryFilesIo extends MemoryFilesIo {
  /** 当前所有文件的快照（path → content），供探针断言。 */
  snapshot(): Readonly<Record<string, string>>
}

/**
 * 纯内存实现：探针与 headless 宿主用。
 *
 * 目录以「存在过写入」隐式表达——权威层没有空目录语义，索引文件缺席就等于该作用域没记忆。
 */
export function createInMemoryMemoryFilesIo(
  seed: Readonly<Record<string, string>> = {},
): InMemoryMemoryFilesIo {
  const normalize = (path: string): string =>
    path.replaceAll('\\', '/').replace(/\/+/gu, '/')
  const files = new Map<string, string>(
    Object.entries(seed).map(([path, content]) => [normalize(path), content]),
  )

  return {
    join(...segments) {
      return normalize(segments.filter((segment) => segment.length > 0).join('/'))
    },
    ensureDirectory() {
      // 内存实现没有独立目录节点：写文件即建目录。
    },
    listFiles(directory) {
      const prefix = `${normalize(directory).replace(/\/$/u, '')}/`
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map((path) => path.slice(prefix.length))
        .sort()
    },
    readTextFile(path) {
      return files.get(normalize(path)) ?? null
    },
    writeTextFile(path, content) {
      files.set(normalize(path), content)
    },
    deleteFile(path) {
      files.delete(normalize(path))
    },
    snapshot() {
      return Object.fromEntries(
        [...files.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
      )
    },
  }
}
