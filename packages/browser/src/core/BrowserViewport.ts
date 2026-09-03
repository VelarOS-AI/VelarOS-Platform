import type { BrowserViewportOptions } from './types.js'

export interface BrowserViewportDeviceMetrics {
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  deviceScaleFactor: number
  mobile: boolean
}

/**
 * 把公开 viewport 契约归一成两种 driver 共用的 CDP 设备指标。
 * width / height 始终表示 CSS 像素；mobile 缺省为 false，兼容已有调用方。
 */
export function buildBrowserViewportDeviceMetrics(
  options: BrowserViewportOptions
): BrowserViewportDeviceMetrics {
  const width = Math.max(1, Math.round(options.width))
  const height = Math.max(1, Math.round(options.height))

  return {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor: 1,
    mobile: options.mobile === true,
  }
}
