import { isString } from '@velaros-ai/core'

import type { BrowserPageDiagnosticEntry, BrowserPageDiagnosticLevel } from '../core'

import type { BrowserSession } from './BrowserRuntimeTypes'

/** 单个会话最多保留的诊断条数。 */
const MAX_DIAGNOSTIC_ENTRIES = 300

/** 浏览器诊断记录器，负责追加和裁剪会话诊断日志。 */
class BrowserDiagnosticsRecorder {
  /** 供查询接口约束 limit 使用。 */
  get maxEntries(): number {
    return MAX_DIAGNOSTIC_ENTRIES
  }

  /** 追加诊断条目，并保持固定长度窗口。 */
  public record(session: BrowserSession, entry: BrowserPageDiagnosticEntry): void {
    session.diagnostics.push(entry)
    if (session.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
      session.diagnostics.splice(0, session.diagnostics.length - MAX_DIAGNOSTIC_ENTRIES)
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
}

export { BrowserDiagnosticsRecorder }
