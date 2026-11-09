import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { isFiniteNumber, isRecord } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { currentPlatform } from '@velaros-ai/core/platform'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'

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
  /** 接收浏览器传输进度；目标落盘成功或失败后才通过 done 通知最终状态。 */
  updateProgress(event: CdpDownloadProgressEvent): void
  /** 排空已经启动的目标落盘；未启动时为 null，不等待尚未受理的下载。 */
  drainFinalization(): Nullable<Promise<void>>
}

/** 见 {@link CdpBrowserPageDownloadItemApi}。 */
export class CdpBrowserPageDownloadItem implements CdpBrowserPageDownloadItemApi {
  private totalBytes = 0
  private receivedBytes = 0
  private savePath = ''
  private doneState: Nullable<CdpDownloadDoneState | 'interrupted'> = null
  private downloadCompleted = false
  private finalization: Nullable<Promise<void>> = null
  private readonly doneListeners: Array<(_event: unknown, state: string) => void> = []

  constructor(
    private readonly options: CdpBrowserPageDownloadItemOptions,
    private readonly moveFile: typeof rename = rename
  ) {}

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
    if (this.doneState || this.finalization) return
    if (this.downloadCompleted) {
      void unlink(this.resolveSourcePath()).catch(() => {
        // arch-guard:silent-catch-ok 下载已完成后的源文件清理是幂等 best-effort，文件可能已被移动。
      })
      this.markDone('cancelled')
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
    this.startFinalization()
  }

  public drainFinalization(): Nullable<Promise<void>> {
    return this.finalization
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

  public updateProgress(event: CdpDownloadProgressEvent): void {
    if (isFiniteNumber(event.totalBytes)) {
      this.totalBytes = Math.max(0, Math.round(event.totalBytes))
    }
    if (isFiniteNumber(event.receivedBytes)) {
      this.receivedBytes = Math.max(0, Math.round(event.receivedBytes))
    }
    if (this.doneState) return

    if (event.state === 'completed') {
      this.downloadCompleted = true
      this.startFinalization()
      return
    }
    if (event.state === 'canceled' || event.state === 'cancelled') {
      if (this.finalization) return
      this.markDone('cancelled')
      return
    }
  }

  private markDone(state: CdpDownloadDoneState | 'interrupted'): void {
    if (this.doneState) return

    this.doneState = state
    const listeners = this.doneListeners.splice(0, this.doneListeners.length)
    for (const listener of listeners) {
      listener(null, state)
    }
  }

  private startFinalization(): void {
    if (this.finalization || this.doneState || !this.downloadCompleted || !this.savePath.trim())
      return

    this.finalization = this.finalizeAcceptedDownload()
  }

  private async finalizeAcceptedDownload(): Promise<void> {
    const sourcePath = this.resolveSourcePath()
    const targetPath = this.savePath
    let renameError: unknown = null
    let copyError: unknown = null
    try {
      await this.assertSavePathUnchanged(targetPath)
      await mkdir(dirname(targetPath), { recursive: true })
      await this.assertSavePathUnchanged(targetPath)
      if (sourcePath === targetPath) {
        if (!(await stat(targetPath)).isFile())
          throw new AppError('VALIDATION', '下载目标不是普通文件。')
      } else {
        try {
          await this.moveFile(sourcePath, targetPath)
        } catch (error) {
          renameError = error
          // 仅跨卷移动需要复制；权限或路径校验失败不能借复制绕过。
          if (!isRecord(error) || error.code !== 'EXDEV') throw error
          await this.assertSavePathUnchanged(targetPath)
          try {
            await copyFile(sourcePath, targetPath)
          } catch (error) {
            copyError = error
            throw error
          }
          await unlink(sourcePath).catch(() => {
            // arch-guard:silent-catch-ok 目标复制已成功，源文件删除失败不改变落盘结果。
          })
        }
      }
      this.markDone('completed')
    } catch (error) {
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
          state: 'interrupted',
          error: AppError.from(error).message,
          code: AppError.from(error).code,
          renameError: renameError ? AppError.from(renameError).message : null,
          copyError: copyError ? AppError.from(copyError).message : null,
        },
      })
      this.markDone('interrupted')
    }
  }

  /** Runtime 已授权规范绝对目标；重新解析必须仍是原目标，不重新扩张授权根。 */
  private async assertSavePathUnchanged(targetPath: string): Promise<void> {
    if (!isAbsolute(targetPath))
      throw new AppError('VALIDATION', '下载目标必须是已解析的绝对路径。')
    const currentPath = await resolveRealPath(targetPath)
    if (targetPath !== this.savePath) throw new AppError('CONFLICT', '下载目标在落盘期间发生改变。')
    if (
      currentPlatform.normalizePathTextForComparison(currentPath) !==
      currentPlatform.normalizePathTextForComparison(resolve(targetPath))
    ) {
      throw new AppError('PERMISSION', '下载目标路径在受理后发生改变。', undefined, {
        targetPath,
        currentPath,
      })
    }
  }

  private resolveSourcePath(): string {
    return join(this.options.downloadPath, this.options.guid)
  }
}
