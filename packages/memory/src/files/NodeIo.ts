/**
 * `MemoryFilesIo` 的 Node 实现。
 *
 * 单独成模块的理由：`./Io` 是端口 + 内存实现，必须能在不碰 `node:fs` 的环境里被加载
 * （探针、未来的 headless / 浏览器侧只读投影）。真实文件系统的依赖全部收在这里一处。
 *
 * 写入走 temp + rename：权威层被外部编辑器、git 和用户同时看着，半截文件比丢一次写入更糟。
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
import { dirname, join as joinPath } from 'node:path'

import type { MemoryFilesIo } from './Io'

const nodeMemoryFilesIo: MemoryFilesIo = {
  join(...segments) {
    return joinPath(...segments)
  },
  ensureDirectory(directory) {
    mkdirSync(directory, { recursive: true })
  },
  listFiles(directory) {
    if (!existsSync(directory)) return []
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  },
  readTextFile(path) {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  },
  writeTextFile(path, content) {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, path)
  },
  deleteFile(path) {
    rmSync(path, { force: true })
  },
}

export function createNodeMemoryFilesIo(): MemoryFilesIo {
  return nodeMemoryFilesIo
}
