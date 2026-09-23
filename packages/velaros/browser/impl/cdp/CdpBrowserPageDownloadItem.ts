import { copyFile, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { isFiniteNumber } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserPageDriverDownloadItem } from '../../contract/requires.js'
import type {
  CdpBrowserPageDownloadItemOptions,
  CdpDownloadDoneState,
  CdpDownloadProgressEvent,
} from '../../types/cdp.js'

/**
 * 一条正在下载的 CDP 条目：既是宿主端口要的那份下载项，也带着 CDP 侧独有的两件——
 * 服务端给的源地址，和按 `Browser.downloadProgress` 事件推进的进度。
 */
export interface CdpBrowserPageDownloadItemApi extends BrowserPageDriverDownloadItem {
  /** 服务端给的下载源地址；CDP 不一定给，给不出时是 null。 */
  getURL(): Nullable<string>
  /** 按一条下载进度事件推进状态；到达终态时回终态，否则回 null。 */
  updateProgress(event: CdpDownloadProgressEvent): Nullable<CdpDownloadDoneState>
}

/** 见 {@link CdpBrowserPageDownloadItemApi}。 */
export class CdpBrowserPageDownloadItem implements CdpBrowserPageDownloadItemApi {
  private totalBytes = 0
  private receivedBytes = 0
  private savePath = ''
  private doneState: Nullable<CdpDownloadDoneState> = null
  private finalized = false
  private readonly doneListeners: Array<(_event: unknown, state: string) => void> = []

  constructor(private readonly options: CdpBrowserPageDownloadItemOptions) {}

  public getFilename(): string {
    return this.options.filename
  }

  public getMimeType(): string {
    return ''
  }

  public getTotalBytes(): number {
    return this.totalBytes
  }

  public getReceivedBytes(): number {
    return this.receivedBytes
  }

  public getSavePath(): string {
    return this.savePath
  }

  public getURL(): Nullable<string> {
    return this.options.url
  }

  public pause(): void {
    // 裸 CDP 下载事件无法在浏览器写入文件前真正暂停。
  }

  public cancel(): void {
    if (this.doneState === 'completed') {
      void unlink(this.resolveSourcePath()).catch(() => {
        // arch-guard:silent-catch-ok 下载已完成后的源文件清理是幂等 best-effort，文件可能已被移动。
      })
      return
    }

    void this.options.transport
      .send('Browser.cancelDownload', { guid: this.options.guid })
      .catch(() => {
        // arch-guard:silent-catch-ok cancel 本身是尽力清理；本地状态仍会明确进入 cancelled。
      })
    this.markDone('cancelled')
  }

  public setSavePath(path: string): void {
    this.savePath = path
  }

  public resume(): void {
    void this.finalizeAcceptedDownload()
  }

  public once(
    event: 'done',
    listener: (_event: unknown, state: string) => void
  ): CdpBrowserPageDownloadItem {
    if (event !== 'done') return this

    if (this.doneState) {
      queueMicrotask(() => listener(null, this.doneState!))
      return this
    }

    this.doneListeners.push(listener)
    return this
  }

  public updateProgress(event: CdpDownloadProgressEvent): Nullable<CdpDownloadDoneState> {
    if (isFiniteNumber(event.totalBytes)) {
      this.totalBytes = Math.max(0, Math.round(event.totalBytes))
    }
    if (isFiniteNumber(event.receivedBytes)) {
      this.receivedBytes = Math.max(0, Math.round(event.receivedBytes))
    }

    if (event.state === 'completed') {
      this.markDone('completed')
      return 'completed'
    }
    if (event.state === 'canceled' || event.state === 'cancelled') {
      this.markDone('cancelled')
      return 'cancelled'
    }

    return null
  }

  private markDone(state: CdpDownloadDoneState): void {
    if (this.doneState) return

    this.doneState = state
    if (state === 'completed') {
      void this.finalizeAcceptedDownload()
    }
    const listeners = this.doneListeners.splice(0, this.doneListeners.length)
    for (const listener of listeners) {
      listener(null, state)
    }
  }

  private async finalizeAcceptedDownload(): Promise<void> {
    if (this.finalized || this.doneState !== 'completed' || !this.savePath.trim()) return

    this.finalized = true
    const sourcePath = this.resolveSourcePath()
    const targetPath = this.savePath
    if (sourcePath === targetPath) return

    try {
      await mkdir(dirname(targetPath), { recursive: true })
      await rename(sourcePath, targetPath)
    } catch (renameError) {
      try {
        await copyFile(sourcePath, targetPath)
        await unlink(sourcePath).catch(() => {
          // arch-guard:silent-catch-ok copy 已成功，源文件可能被浏览器并发移走；不能把成功下载改判失败。
        })
      } catch (copyError) {
        this.options.appendDiagnostic({
          kind: 'download',
          level: 'warning',
          message: `CDP 下载完成但无法移动到目标路径：${this.options.filename}`,
          url: this.options.url,
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            guid: this.options.guid,
            sourcePath,
            targetPath,
            renameError: AppError.from(renameError).message,
            copyError: AppError.from(copyError).message,
          },
        })
      }
    }
  }

  private resolveSourcePath(): string {
    return join(this.options.downloadPath, this.options.guid)
  }
}
