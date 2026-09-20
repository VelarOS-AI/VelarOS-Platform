/**
 * 本机文件端口：`LocalFilePort`，`velaros:files` 的空间端口 `FileSpacePort` 在本机上的实现，由 `createLocalFilePort` 创建。
 * 路径可以是本机任意位置（怎么解析由宿主给的 `resolvePath` 定），读写解开符号链接之后的那个文件；
 * 写是逐个原子替换（缺的上级目录补建），撤回一次新建是核对后删掉。
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AppError, isNull } from '@velaros-ai/core'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

import type { FileSpacePort, LocalFilePortOptions } from '../contract/requires.js'
import type { FileLocation } from '../types/files.js'
import type { FileWrite } from '../types/space.js'
import { removeFileChecked, writeFileAtomically } from '../utils/fs.js'

/** 按配置建一个本机文件端口。 */
export function createLocalFilePort(options: LocalFilePortOptions): FileSpacePort {
  return new LocalFilePort(options)
}

export class LocalFilePort implements FileSpacePort {
  private readonly options: LocalFilePortOptions

  constructor(options: LocalFilePortOptions) {
    this.options = options
  }

  public async locate(path: string): Promise<FileLocation> {
    const resolved = this.options.resolvePath(path)
    const target = await resolveRealPath(resolved)
    return { path: resolved, target, linked: target !== resolved }
  }

  public async commit(writes: readonly FileWrite[]): Promise<void> {
    const applied: string[] = []
    for (const write of writes) {
      try {
        if (isNull(write.bytes)) await removeFileChecked(write.target, write.expected)
        else {
          await mkdir(dirname(write.target), { recursive: true })
          await writeFileAtomically(write.target, write.bytes, write.expected)
        }
        applied.push(write.target)
      } catch (error) {
        // 做到一半出错：已经落盘的在错误的 context.applied 里点名。
        const failure = AppError.from(error)
        throw new AppError(failure.code, failure.message, error, { applied })
      }
    }
  }
}
