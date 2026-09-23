/**
 * 落盘的变更记录：`FileProjectChangeFeed` 与工厂 `createFileProjectChangeFeed`。接口 `FileProjectChangeFeedApi` 在本文件的类上方。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { ProjectChangeFeedWriter } from '../../contract/requires.js'
import type { FileProjectChangeFeedOptions, ProjectChangeRecord } from '../../types/change-feed.js'
import { isProjectChangeRecord } from '../../utils/transactions/change-records.js'

import { BaseProjectChangeFeed } from './BaseProjectChangeFeed.js'

/**
 * 追加写的 JSONL 变更记录：每条先 fsync 再通知订阅者；重新打开时按生命周期行重建每个事务的最新投影，末尾写了一半的行忽略。
 * 放在宿主私有目录（项目树之外），交给 createProjectKernel 的 changeFeed，事务跨进程重启后仍能列出和回滚。
 */
export interface FileProjectChangeFeedApi extends ProjectChangeFeedWriter {
  /** 记录文件的绝对路径。 */
  readonly path: string
  /** 关掉文件句柄；之后再记录会报错。 */
  close(): void
}

export class FileProjectChangeFeed
  extends BaseProjectChangeFeed
  implements FileProjectChangeFeedApi
{
  public readonly path: string
  private static readonly DirectoryMode = 0o700
  private static readonly FileMode = 0o600
  private readonly descriptor: number
  private closed = false

  public constructor(options: FileProjectChangeFeedOptions) {
    super()
    this.path = resolve(options.path)
    mkdirSync(dirname(this.path), { recursive: true, mode: FileProjectChangeFeed.DirectoryMode })
    if (existsSync(this.path)) {
      const source = readFileSync(this.path, 'utf8')
      this.load(source)
      this.truncateTornTail(source)
    }
    this.descriptor = openSync(this.path, 'a', FileProjectChangeFeed.FileMode)
  }

  /**
   * 崩溃在追加中途会留下没有换行结尾的残行。读回时忽略它还不够：打开追加之前必须把它截掉，
   * 否则下一条记录接在残行后面拼成一行，那一行永远解析不了，整份记录从此坏掉。
   */
  private truncateTornTail(source: string): void {
    if (!source || source.endsWith('\n')) return
    const lastNewline = source.lastIndexOf('\n')
    truncateSync(
      this.path,
      lastNewline === -1 ? 0 : Buffer.byteLength(source.slice(0, lastNewline + 1), 'utf8')
    )
  }

  /** 读回已有的记录文件：每行一条，只有最后一行没写完（没有换行结尾）时允许坏掉。 */
  private load(source: string): void {
    const lines = source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim()
      if (!line) continue
      try {
        const change: unknown = JSON.parse(line)
        if (!isProjectChangeRecord(change))
          throw new AppError('VALIDATION', '变更记录文件里有一行不是合法的变更记录。')
        this.hydrate(change)
      } catch (error) {
        const isLastPartialLine = index === lines.length - 1 && !source.endsWith('\n')
        if (!isLastPartialLine) throw error
      }
    }
  }

  protected persist(change: ProjectChangeRecord): void {
    if (this.closed) throw new AppError('CLOSED', '变更记录已经关闭，不能再记录。')
    appendFileSync(this.descriptor, `${JSON.stringify(change)}\n`, 'utf8')
    fsyncSync(this.descriptor)
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.descriptor)
  }
}

/** 创建落盘的变更记录，交给 createProjectKernel 的 changeFeed；用完调 close。 */
export function createFileProjectChangeFeed(
  options: FileProjectChangeFeedOptions
): FileProjectChangeFeedApi {
  return new FileProjectChangeFeed(options)
}
