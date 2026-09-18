import { isString } from '@velaros-ai/core'

import type { BrowserPageDiagnosticEntry, BrowserPageDiagnosticLevel } from '../../types/browser'
import type { BrowserSession } from '../../types/electron'
import { BrowserTuning } from '../../utils/tuning'

/** 单个会话最多保留的诊断条数。 */

/** 浏览器诊断记录器，负责追加和裁剪会话诊断日志。 */
export interface BrowserDiagnosticsRecorderApi {
  /** 供查询接口约束 limit 使用。 */
  readonly maxEntries: number
  /** 追加诊断条目，并保持固定长度窗口。 */
  record(session: BrowserSession, entry: BrowserPageDiagnosticEntry): void
  /** 将 Electron console-message level 归一化为共享类型。 */
  normalizeConsoleLevel(level: unknown): BrowserPageDiagnosticLevel
  /**
   * Electron injects development-only security notices through its own `node:electron` source.
   * They describe the host shell, not the inspected site, and therefore must not be projected as
   * page diagnostics. Site-originated CSP and console messages remain untouched.
   */
  /** 这条 console 消息要不要记：内部桥接用的消息（用户活动回传）不进诊断。 */
  shouldRecordConsoleMessage(message: string, sourceId: string): boolean
}

class BrowserDiagnosticsRecorder implements BrowserDiagnosticsRecorderApi {
  /** 供查询接口约束 limit 使用。 */
  get maxEntries(): number {
    return BrowserTuning.diagnostics.maxEntries
  }

  /** 追加诊断条目，并保持固定长度窗口。 */
  public record(session: BrowserSession, entry: BrowserPageDiagnosticEntry): void {
    session.diagnostics.push(entry)
    if (session.diagnostics.length > BrowserTuning.diagnostics.maxEntries) {
      session.diagnostics.splice(0, session.diagnostics.length - BrowserTuning.diagnostics.maxEntries)
    }
  }

  /** 将 Electron console-message level 归一化为共享类型。 */
  public normalizeConsoleLevel(level: unknown): BrowserPageDiagnosticLevel {
    if (isString(level)) {
      if (level === 'debug' || level === 'warning' || level === 'error') return level

      return 'info'
    }

    switch (level) {
      case 1: {
        return 'warning'
      }
      case 2: {
        return 'error'
      }
      case 3: {
        return 'debug'
      }
      default: {
        return 'info'
      }
    }
  }

  /**
   * Electron injects development-only security notices through its own `node:electron` source.
   * They describe the host shell, not the inspected site, and therefore must not be projected as
   * page diagnostics. Site-originated CSP and console messages remain untouched.
   */
  public shouldRecordConsoleMessage(message: string, sourceId: string): boolean {
    const normalizedSource = sourceId.trim().toLowerCase()
    const normalizedMessage = message.trimStart()
    return !(
      normalizedSource.startsWith('node:electron/') &&
      normalizedMessage.includes('Electron Security Warning')
    )
  }
}

export { BrowserDiagnosticsRecorder }
