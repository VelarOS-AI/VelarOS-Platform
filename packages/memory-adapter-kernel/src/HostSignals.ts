/**
 * 宿主空闲信号端口。
 *
 * MemoryDreamScheduler 判定「设备是否适合后台整理」需要三个宿主运行态读数：系统空闲时长、
 * 是否电池供电、是否有前台聚焦窗口。这些读数在 Desktop 上来自 Electron（powerMonitor /
 * BrowserWindow），但记忆适配器本体必须 host 无关——端口把它们收成一个窄接口注入，Electron
 * 实现留在 apps/desktop 胶水。窄到只有三个纯读数，无状态、无生命周期。
 */
export interface HostIdleSignalPort {
  /** 系统连续空闲秒数（Electron powerMonitor.getSystemIdleTime 等价）。读取失败由调用方兜底为 0。 */
  getIdleSeconds(): number
  /** 设备当前是否电池供电（Electron powerMonitor.isOnBatteryPower 等价）。 */
  isOnBatteryPower(): boolean
  /** 是否存在未销毁且聚焦的前台窗口（Electron BrowserWindow 聚焦判定等价）。 */
  isAppFocused(): boolean
}
