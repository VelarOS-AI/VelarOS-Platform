import { isFiniteNumber, isNonBlankString, isNotNull, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserPageDriverEmulationState } from './BrowserPageDriver'
import type { BrowserEmulationOptions, BrowserGeolocationOptions, BrowserGeolocationState, BrowserNetworkThrottlingPreset } from './types.js'

/**
 * CDP 环境模拟共享逻辑。
 *
 * 外部 CDP 浏览器(CdpBrowserPageDriver,WebSocket transport)和嵌入式 webview
 * (webContents.debugger)两条路径共用同一套 CDP Emulation/Network 命令,只差
 * transport。这里只负责"按 options 合成 CDP 命令 + 演进状态",不持有 transport。
 */

/** 网络节流预设 → CDP Network.emulateNetworkConditions 参数(与 DevTools 面板同源)。 */
export const CdpNetworkThrottlingPresets: Record<
  BrowserNetworkThrottlingPreset,
  { latencyMs: number; downloadBytesPerSecond: number; uploadBytesPerSecond: number }
> = {
  none: { latencyMs: 0, downloadBytesPerSecond: -1, uploadBytesPerSecond: -1 },
  'slow-3g': {
    latencyMs: 2000,
    downloadBytesPerSecond: (500 * 1000) / 8 * 0.8,
    uploadBytesPerSecond: (500 * 1000) / 8 * 0.8,
  },
  'fast-3g': {
    latencyMs: 562.5,
    downloadBytesPerSecond: (1.6 * 1000 * 1000) / 8 * 0.9,
    uploadBytesPerSecond: (750 * 1000) / 8 * 0.9,
  },
  'slow-4g': {
    latencyMs: 562.5,
    downloadBytesPerSecond: (1.6 * 1000 * 1000) / 8 * 0.9,
    uploadBytesPerSecond: (750 * 1000) / 8 * 0.9,
  },
  'fast-4g': {
    latencyMs: 165,
    downloadBytesPerSecond: (9 * 1000 * 1000) / 8 * 0.9,
    uploadBytesPerSecond: (1.5 * 1000 * 1000) / 8 * 0.9,
  },
}

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export function createDefaultCdpEmulationState(): BrowserPageDriverEmulationState {
  return {
    colorScheme: 'no-preference',
    reducedMotion: 'no-preference',
    timezoneId: null,
    locale: null,
    geolocation: null,
    cpuThrottlingRate: 1,
    networkThrottling: 'none',
  }
}

function normalizeNullableEmulationString(value: string): Nullable<string> {
  const normalized = value.trim()
  return isNonBlankString(normalized) ? normalized : null
}

function normalizeCpuThrottlingRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.min(20, Math.max(1, rate))
}

function normalizeGeolocation(options: BrowserGeolocationOptions): BrowserGeolocationState {
  if (!isFiniteNumber(options.latitude) || options.latitude < -90 || options.latitude > 90) {
    throw new AppError('VALIDATION', '地理位置 latitude 必须在 -90 到 90 之间。')
  }
  if (!isFiniteNumber(options.longitude) || options.longitude < -180 || options.longitude > 180) {
    throw new AppError('VALIDATION', '地理位置 longitude 必须在 -180 到 180 之间。')
  }
  const accuracy = isFiniteNumber(options.accuracy) ? Math.max(0, options.accuracy) : 1
  return { latitude: options.latitude, longitude: options.longitude, accuracy }
}

function cloneGeolocation(
  geolocation: Nullable<BrowserGeolocationState>
): Nullable<BrowserGeolocationState> {
  return isNotNull(geolocation) ? { ...geolocation } : null
}

/**
 * offline 与网络节流共用 Network.emulateNetworkConditions,统一合成下发避免互相覆盖。
 * offline 由 configureNetwork 维护;emulation-only 场景传 false。
 */
export async function syncCdpNetworkConditions(
  send: CdpSend,
  networkThrottling: BrowserNetworkThrottlingPreset,
  offline: boolean
): Promise<void> {
  const preset = CdpNetworkThrottlingPresets[networkThrottling]
  await send('Network.emulateNetworkConditions', {
    offline,
    latency: preset.latencyMs,
    downloadThroughput: preset.downloadBytesPerSecond,
    uploadThroughput: preset.uploadBytesPerSecond,
  })
}

/**
 * 按 options 下发 CDP 环境模拟命令并返回演进后的状态。
 * @param offline 当前网络离线态(configureNetwork 维护),用于合成节流条件。
 */
export async function applyCdpEmulation(
  send: CdpSend,
  current: BrowserPageDriverEmulationState,
  options: BrowserEmulationOptions,
  offline = false
): Promise<BrowserPageDriverEmulationState> {
  const next: BrowserPageDriverEmulationState = { ...current }

  const shouldConfigureMedia = isPresent(options.colorScheme) || isPresent(options.reducedMotion)
  if (isPresent(options.colorScheme)) next.colorScheme = options.colorScheme
  if (isPresent(options.reducedMotion)) next.reducedMotion = options.reducedMotion
  if (shouldConfigureMedia) {
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: next.colorScheme },
        { name: 'prefers-reduced-motion', value: next.reducedMotion },
      ],
    })
  }

  if (isPresent(options.timezoneId)) {
    next.timezoneId = normalizeNullableEmulationString(options.timezoneId)
    await send('Emulation.setTimezoneOverride', { timezoneId: next.timezoneId ?? '' })
  }

  if (isPresent(options.locale)) {
    next.locale = normalizeNullableEmulationString(options.locale)
    await send('Emulation.setLocaleOverride', { locale: next.locale ?? '' })
  }

  if (isPresent(options.geolocation)) {
    next.geolocation = normalizeGeolocation(options.geolocation)
    await send('Emulation.setGeolocationOverride', { ...next.geolocation })
  }

  if (isPresent(options.cpuThrottlingRate)) {
    next.cpuThrottlingRate = normalizeCpuThrottlingRate(options.cpuThrottlingRate)
    await send('Emulation.setCPUThrottlingRate', { rate: next.cpuThrottlingRate })
  }

  if (isPresent(options.networkThrottling)) {
    next.networkThrottling = options.networkThrottling
    await syncCdpNetworkConditions(send, next.networkThrottling, offline)
  }

  return {
    ...next,
    geolocation: cloneGeolocation(next.geolocation),
  }
}
