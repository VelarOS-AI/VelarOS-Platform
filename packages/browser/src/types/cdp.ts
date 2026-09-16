import type { CdpBrowserPageDriverTransport } from '../impl/cdp/CdpBrowserPageDriver.js'

import type { BrowserPageDiagnosticEntry } from './browser.js'

export interface CdpDownloadProgressEvent {
  guid?: unknown
  totalBytes?: unknown
  receivedBytes?: unknown
  state?: unknown
}

/**
 * 网络节流预设 → CDP Network.emulateNetworkConditions 参数。
 * 吞吐单位 bytes/s，-1 表示不限速；数值与 DevTools 前端预设保持一致。
 */
export type CdpDownloadDoneState = 'completed' | 'cancelled'

export interface CdpBrowserPageDownloadItemOptions {
  transport: CdpBrowserPageDriverTransport
  guid: string
  url: Nullable<string>
  filename: string
  downloadPath: string
  appendDiagnostic: (entry: BrowserPageDiagnosticEntry) => void
}
