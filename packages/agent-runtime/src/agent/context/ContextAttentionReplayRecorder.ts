import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { logRuntime } from '@velaros-ai/core/logger'
import type { ChatContextDebugTraceEntry } from '@velaros-ai/core/types'

import type { ProviderRequestFingerprint } from '../../kernel/provider-events'

import type { ContextAttentionRouterMode } from './ContextAttentionPolicyEngine'

export interface ContextAttentionReplayDecisionRecord {
  blockId: string
  action: ChatContextDebugTraceEntry['action']
  score?: LooseOptional<number>
  reason: string
  metadata?: Record<string, unknown>
}

export interface ContextAttentionReplayRecord {
  schemaVersion: 1
  routeId: string
  timestamp: number
  mode: ContextAttentionRouterMode
  budgetTokens: Nullable<number>
  requestFingerprint?: ProviderRequestFingerprint
  decisions: ContextAttentionReplayDecisionRecord[]
}

export interface ContextAttentionReplayRecorder {
  record(record: ContextAttentionReplayRecord): void
}

const log = logRuntime.tag('ContextAttentionReplayRecorder')

/**
 * JSONL 落盘回放记录器：`record` 只把行推入内存缓冲并调度一次异步 flush，**绝不在编译热路径上
 * 做同步磁盘 IO**（旧实现每次 record 都 sync `mkdir/stat/append`，编译器每 reclaim pass 都触发）。
 * flush 在下一 tick 批量落盘;失败只 warn(回放是诊断产物,丢失不得回冒进编译)。
 */
export class JsonlContextAttentionReplayRecorder implements ContextAttentionReplayRecorder {
  private pendingLines: string[] = []
  private flushScheduled = false
  private flushing = false

  constructor(
    private readonly filePath: string,
    private readonly options: { maxBytes?: LooseOptional<number> } = {}
  ) {}

  public record(record: ContextAttentionReplayRecord): void {
    this.pendingLines.push(`${JSON.stringify(record)}\n`)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushing) return
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      void this.flush()
    })
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pendingLines.length === 0) return
    this.flushing = true
    const batch = this.pendingLines
    this.pendingLines = []
    try {
      const payload = batch.join('')
      await mkdir(dirname(this.filePath), { recursive: true })
      const maxBytes = Math.max(1, Math.floor(this.options.maxBytes ?? 5_000_000))
      const currentBytes = await this.currentFileBytes()
      if (currentBytes + Buffer.byteLength(payload, 'utf8') > maxBytes) {
        await writeFile(this.filePath, '', 'utf8')
      }
      await appendFile(this.filePath, payload, 'utf8')
    } catch (error) {
      log.warn('context attention replay flush failed; dropping buffered records', {
        error: String(error),
        dropped: batch.length,
      })
    } finally {
      this.flushing = false
      if (this.pendingLines.length > 0) this.scheduleFlush()
    }
  }

  private async currentFileBytes(): Promise<number> {
    try {
      return (await stat(this.filePath)).size
    } catch {
      // arch-guard:silent-catch-ok 文件尚不存在按 0 字节处理,首次 append 时创建。
      return 0
    }
  }
}
