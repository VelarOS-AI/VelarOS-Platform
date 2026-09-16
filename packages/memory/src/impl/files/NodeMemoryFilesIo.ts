/**
 * `MemoryFilesIo` 的 Node 实现。
 *
 * 单独成类的理由：端口与内存实现必须能在不碰 `node:fs` 的环境里被加载（探针、未来的 headless /
 * 浏览器侧只读投影）。真实文件系统的依赖全部收在这里一处。
 *
 * 写入走同目录临时文件 + fsync + rename + 目录 fsync：权威层被外部编辑器、git 和用户同时看着，
 * 半截文件比丢一次写入更糟；只做 temp + rename 而不 fsync 的话，一次断电就可能留下一个长度
 * 正确、内容全零的条目。语义与 `@velaros-ai/text-files` 的原子替换一致——那套实现是异步的，
 * 本端口是同步的，接不进来（端口异步化是记忆包改造方案排在后面的一步）。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join as joinPath, relative, sep } from 'node:path'

import { isEmpty } from '@velaros-ai/core'

import type { MemoryFilesIo } from '../../contract/requires'
import { readFileMode, resolveRealPathSync, syncPath } from '../../utils/files/node-paths'

/** 真实文件系统上的记忆文件 IO；实例由 `createNodeMemoryFilesIo` 给，整个进程共用一份（无状态）。 */
export class NodeMemoryFilesIo implements MemoryFilesIo {
  public join(...segments: readonly string[]): string {
    return joinPath(...segments)
  }

  public ensureDirectory(directory: string): void {
    mkdirSync(directory, { recursive: true })
  }

  public listFiles(directory: string): readonly string[] {
    if (!existsSync(directory)) return []
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  }

  public readTextFile(path: string): Nullable<string> {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  }

  public writeTextFile(path: string, content: string): void {
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true })
    const temporary = `${path}.tmp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', mode: readFileMode(path) })
      syncPath(temporary)
      renameSync(temporary, path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    // 改名本身也要落盘，否则崩溃后目录项可能还指着旧文件（Windows 没有这一步的语义，失败即忽略）。
    syncPath(directory)
  }

  public deleteFile(path: string): void {
    rmSync(path, { force: true })
  }

  public isInsideDirectory(path: string, root: string): boolean {
    // 两边都先解成真实路径再比：条目目录里一个指向 `~/.aws/credentials` 的符号链接，
    // 文本判定看不出来，解开之后一眼就在根外。
    const rest = relative(resolveRealPathSync(root), resolveRealPathSync(path))
    if (isEmpty(rest)) return true
    if (rest === '..' || rest.startsWith(`..${sep}`)) return false
    return !isAbsolute(rest)
  }
}

/** 整个进程共用的 Node 文件 IO 实例（无状态，重复构造没有意义）。 */
export const nodeMemoryFilesIo: MemoryFilesIo = new NodeMemoryFilesIo()

/** 取真实文件系统上的记忆文件 IO。 */
export function createNodeMemoryFilesIo(): MemoryFilesIo {
  return nodeMemoryFilesIo
}
