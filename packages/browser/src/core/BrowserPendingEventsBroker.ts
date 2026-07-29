import { toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserPageDriverDownloadItem } from './BrowserPageDriver'
import type { BrowserPendingEventSummary } from './types.js'

const DefaultDialogTimeoutMs = 30_000
const DefaultPermissionTimeoutMs = 15_000
const DefaultDownloadTimeoutMs = 60_000

interface PendingDialogEntry {
  id: string
  sessionId: string
  type: string
  message: Nullable<string>
  title: Nullable<string>
  defaultPromptText: Nullable<string>
  createdAt: number
  resolve: (response: { accept: boolean; promptText: string }) => void
}

interface PendingDownloadEntry {
  id: string
  sessionId: string
  filename: string
  url: Nullable<string>
  mimeType: string
  totalBytes: number
  item: BrowserPageDriverDownloadItem
  createdAt: number
  settled: boolean
}

interface PendingPermissionEntry {
  id: string
  sessionId: string
  permission: string
  url: Nullable<string>
  requestingUrl: Nullable<string>
  embeddingOrigin: Nullable<string>
  createdAt: number
  resolve: (granted: boolean) => void
}

interface BrowserJavaScriptDialogDetails {
  type?: string
  message?: string
  title?: string
  defaultPromptText?: string
}

/**
 * 管理浏览器阻塞事件（dialog / download / permission）的待处理队列与超时回退。
 */
class BrowserPendingEventsBroker {
  private readonly log = logRuntime.tag('BrowserPendingEventsBroker')
  private readonly timers = new TimerScope({ name: 'BrowserPendingEventsBroker' })
  private readonly pendingDialogs = new Map<string, PendingDialogEntry>()
  private readonly pendingDownloads = new Map<string, PendingDownloadEntry>()
  private readonly pendingPermissions = new Map<string, PendingPermissionEntry>()
  private nextEventId = 1

  /** 清理某个页面会话的阻塞事件，但保留 broker 供后续窗口继续复用。 */
  public clearSession(sessionId: string): void {
    for (const entry of [...this.pendingDialogs.values()]) {
      if (entry.sessionId !== sessionId) continue
      entry.resolve(this.defaultDialogResponse(entry.type))
    }

    for (const entry of [...this.pendingDownloads.values()]) {
      if (entry.sessionId !== sessionId) continue
      this.cancelPendingDownload(entry)
    }

    for (const entry of [...this.pendingPermissions.values()]) {
      if (entry.sessionId !== sessionId) continue
      entry.resolve(false)
    }
  }

  /** 清空当前窗口留下的全部阻塞事件，但不终止 broker 生命周期。 */
  public clearAll(): void {
    for (const entry of [...this.pendingDialogs.values()]) {
      entry.resolve(this.defaultDialogResponse(entry.type))
    }
    for (const entry of [...this.pendingDownloads.values()]) {
      this.cancelPendingDownload(entry)
    }
    for (const entry of [...this.pendingPermissions.values()]) {
      entry.resolve(false)
    }
  }

  public dispose(): void {
    this.clearAll()
    this.timers.dispose()
  }

  public listPendingEvents(sessionId: string): BrowserPendingEventSummary[] {
    const events: BrowserPendingEventSummary[] = []

    for (const entry of this.pendingDialogs.values()) {
      if (entry.sessionId !== sessionId) continue
      events.push({
        id: entry.id,
        kind: 'dialog',
        createdAt: entry.createdAt,
        details: {
          type: entry.type,
          message: entry.message,
          title: entry.title,
          defaultPromptText: entry.defaultPromptText,
        },
      })
    }

    for (const entry of this.pendingDownloads.values()) {
      if (entry.sessionId !== sessionId || entry.settled) continue
      events.push({
        id: entry.id,
        kind: 'download',
        createdAt: entry.createdAt,
        details: {
          filename: entry.filename,
          url: entry.url,
          mimeType: entry.mimeType,
          totalBytes: entry.totalBytes,
          receivedBytes: entry.item.getReceivedBytes(),
          savePath: entry.item.getSavePath() || null,
        },
      })
    }

    for (const entry of this.pendingPermissions.values()) {
      if (entry.sessionId !== sessionId) continue
      events.push({
        id: entry.id,
        kind: 'permission',
        createdAt: entry.createdAt,
        details: {
          permission: entry.permission,
          url: entry.url,
          requestingUrl: entry.requestingUrl,
          embeddingOrigin: entry.embeddingOrigin,
        },
      })
    }

    return events.sort((left, right) => left.createdAt - right.createdAt)
  }

  public handleIncomingDialog(input: {
    sessionId: string
    details: BrowserJavaScriptDialogDetails
    callback: (response: boolean, promptText?: string) => void
  }): void {
    const type = input.details.type ?? 'unknown'
    const id = this.createEventId()
    const createdAt = Date.now()

    const settle = (response: { accept: boolean; promptText: string }) => {
      this.pendingDialogs.delete(id)
      input.callback(response.accept, response.promptText)
    }

    const timeout = this.scheduleTimeout(DefaultDialogTimeoutMs, () => {
      if (!this.pendingDialogs.has(id)) return
      this.log.info('dialog pending timeout, applying default response', {
        sessionId: input.sessionId,
        type,
      })
      settle(this.defaultDialogResponse(type))
    })

    this.pendingDialogs.set(id, {
      id,
      sessionId: input.sessionId,
      type,
      message: toNullable(input.details.message),
      title: toNullable(input.details.title),
      defaultPromptText: toNullable(input.details.defaultPromptText),
      createdAt,
      resolve: (response) => {
        timeout.cancel()
        settle(response)
      },
    })
  }

  public handleIncomingDownload(input: {
    sessionId: string
    item: BrowserPageDriverDownloadItem
    url: Nullable<string>
  }): void {
    const id = this.createEventId()
    const filename = input.item.getFilename()
    const entry: PendingDownloadEntry = {
      id,
      sessionId: input.sessionId,
      filename,
      url: input.url,
      mimeType: input.item.getMimeType(),
      totalBytes: input.item.getTotalBytes(),
      item: input.item,
      createdAt: Date.now(),
      settled: false,
    }

    try {
      input.item.pause()
    } catch (error) {
      this.log.debug('暂停下载失败', { error: AppError.from(error).message })
    }

    this.pendingDownloads.set(id, entry)

    this.scheduleTimeout(DefaultDownloadTimeoutMs, () => {
      const pending = this.pendingDownloads.get(id)
      if (!pending || pending.settled) return
      this.cancelPendingDownload(pending, '下载超时取消失败')
    })
  }

  public handleIncomingPermission(input: {
    sessionId: string
    permission: string
    url: Nullable<string>
    requestingUrl: Nullable<string>
    embeddingOrigin: Nullable<string>
    callback: (granted: boolean) => void
  }): void {
    const id = this.createEventId()
    const createdAt = Date.now()

    const settle = (granted: boolean) => {
      this.pendingPermissions.delete(id)
      input.callback(granted)
    }

    const timeout = this.scheduleTimeout(DefaultPermissionTimeoutMs, () => {
      if (!this.pendingPermissions.has(id)) return
      this.log.info('permission pending timeout, default deny', {
        sessionId: input.sessionId,
        permission: input.permission,
      })
      settle(false)
    })

    this.pendingPermissions.set(id, {
      id,
      sessionId: input.sessionId,
      permission: input.permission,
      url: input.url,
      requestingUrl: input.requestingUrl,
      embeddingOrigin: input.embeddingOrigin,
      createdAt,
      resolve: (granted) => {
        timeout.cancel()
        settle(granted)
      },
    })
  }

  public resolveDialog(input: {
    sessionId: string
    eventId?: string
    accept: boolean
    promptText?: string
  }): { handled: boolean; eventId: string; accept: boolean; promptText: string } {
    const entry = this.findPendingEntry(this.pendingDialogs, input.sessionId, input.eventId)
    if (!entry) {
      throw new AppError('VALIDATION', '没有找到待处理的 JS 弹窗事件。')
    }

    const promptText = input.promptText ?? entry.defaultPromptText ?? ''
    entry.resolve({ accept: input.accept, promptText })
    return {
      handled: true,
      eventId: entry.id,
      accept: input.accept,
      promptText,
    }
  }

  public resolveDownload(input: {
    sessionId: string
    eventId?: string
    action: 'accept' | 'cancel'
    savePath?: string
  }): {
    handled: boolean
    eventId: string
    action: 'accept' | 'cancel'
    savePath: Nullable<string>
    state: Nullable<string>
  } {
    const entry = this.findPendingEntry(this.pendingDownloads, input.sessionId, input.eventId)
    if (!entry || entry.settled) {
      throw new AppError('VALIDATION', '没有找到待处理的下载事件。')
    }

    entry.settled = true
    this.pendingDownloads.delete(entry.id)

    if (input.action === 'cancel') {
      entry.item.cancel()
      return {
        handled: true,
        eventId: entry.id,
        action: 'cancel',
        savePath: null,
        state: 'cancelled',
      }
    }

    const savePath = input.savePath?.trim()
    if (!savePath) {
      throw new AppError('VALIDATION', '接受下载必须提供 savePath。')
    }

    entry.item.setSavePath(savePath)
    try {
      entry.item.resume()
    } catch (error) {
      this.log.debug('恢复下载失败', { error: AppError.from(error).message })
    }

    return {
      handled: true,
      eventId: entry.id,
      action: 'accept',
      savePath,
      state: 'accepted',
    }
  }

  public resolvePermission(input: { sessionId: string; eventId?: string; grant: boolean }): {
    handled: boolean
    eventId: string
    granted: boolean
  } {
    const entry = this.findPendingEntry(this.pendingPermissions, input.sessionId, input.eventId)
    if (!entry) {
      throw new AppError('VALIDATION', '没有找到待处理的权限请求事件。')
    }

    entry.resolve(input.grant)
    return {
      handled: true,
      eventId: entry.id,
      granted: input.grant,
    }
  }

  private createEventId(): string {
    const id = `pending-${this.nextEventId}`
    this.nextEventId += 1
    return id
  }

  private scheduleTimeout(ms: number, callback: () => void): TimerLease {
    return this.timers.after(ms, callback)
  }

  private cancelPendingDownload(
    entry: PendingDownloadEntry,
    failureMessage = '取消待处理下载失败'
  ): void {
    if (entry.settled) return

    entry.settled = true
    this.pendingDownloads.delete(entry.id)
    try {
      entry.item.cancel()
    } catch (error) {
      this.log.debug(failureMessage, { error: AppError.from(error).message })
    }
  }

  private defaultDialogResponse(type: string): { accept: boolean; promptText: string } {
    return {
      accept: type === 'alert',
      promptText: '',
    }
  }

  private findPendingEntry<T extends { id: string; sessionId: string }>(
    store: Map<string, T>,
    sessionId: string,
    eventId?: string
  ): T | undefined {
    if (eventId) {
      const entry = store.get(eventId)
      return entry?.sessionId === sessionId ? entry : undefined
    }

    for (const entry of store.values()) {
      if (entry.sessionId === sessionId) return entry
    }

    return undefined
  }
}

export { BrowserPendingEventsBroker }
