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
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join as joinPath, relative, resolve, sep } from 'node:path'

import { isEmpty, isNotNull } from '@velaros-ai/core'

import type { MemoryFilesIo } from './Io'

/** 悬空符号链接最多追几跳；超过（多半是链接成环）就不再追。 */
const MaxDanglingLinkHops = 40

function readRealPath(path: string): Nullable<string> {
  try {
    return realpathSync(path)
  } catch {
    // arch-guard:silent-catch-ok 路径不存在或读不了都只说明「这一层还解不开」，由调用方继续往上找。
    return null
  }
}

function readLinkTarget(path: string): Nullable<string> {
  try {
    return readlinkSync(path)
  } catch {
    // arch-guard:silent-catch-ok 不是符号链接就没有目标，与「解不开」同一处置。
    return null
  }
}

/**
 * `@velaros-ai/core` 的 `resolveRealPath` 的同步版（端口是同步的，异步实现接不进来）：
 * 解开路径上所有的符号链接；路径还不存在时解开最近一个存在的祖先，再把余下各段接回；
 * 途中或末端是悬空符号链接时照它指向的路径继续解。链接成环、读不了链接时返回规整后的字面路径。
 */
function resolveRealPathSync(path: string): string {
  const literal = resolve(path)
  const trailing: string[] = []
  let current = literal
  let hops = 0
  while (true) {
    const real = readRealPath(current)
    if (isNotNull(real)) return isEmpty(trailing) ? real : joinPath(real, ...[...trailing].reverse())
    const target = readLinkTarget(current)
    if (isNotNull(target)) {
      hops += 1
      if (hops > MaxDanglingLinkHops) return literal
      current = resolve(dirname(current), target)
      continue
    }
    const parent = dirname(current)
    if (parent === current) return literal
    trailing.push(basename(current))
    current = parent
  }
}

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
  isInsideDirectory(path, root) {
    // 两边都先解成真实路径再比：条目目录里一个指向 `~/.aws/credentials` 的符号链接，
    // 文本判定看不出来，解开之后一眼就在根外。
    const rest = relative(resolveRealPathSync(root), resolveRealPathSync(path))
    if (isEmpty(rest)) return true
    if (rest === '..' || rest.startsWith(`..${sep}`)) return false
    return !isAbsolute(rest)
  },
}

export function createNodeMemoryFilesIo(): MemoryFilesIo {
  return nodeMemoryFilesIo
}
