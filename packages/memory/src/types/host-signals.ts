/**
 * 宿主空闲信号端口。
 *
 * MemoryDreamScheduler 判定「设备是否适合后台整理」需要三个宿主运行态读数：系统空闲时长、
 * 是否电池供电、是否有前台聚焦窗口。记忆适配器本体必须 host 无关，因此这些读数经窄接口
 * 注入，具体平台实现留在产品宿主适配层。该端口无状态、无生命周期。
 */
export interface HostIdleSignalPort {
  /** 系统连续空闲秒数。读取失败由调用方兜底为 0。 */
  getIdleSeconds(): number
  /** 设备当前是否电池供电。 */
  isOnBatteryPower(): boolean
  /** 产品宿主是否存在聚焦的前台界面。 */
  isAppFocused(): boolean
}
