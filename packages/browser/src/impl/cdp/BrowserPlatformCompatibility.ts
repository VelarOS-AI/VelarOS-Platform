import type { BrowserCommandSpec } from '../../types/runtime.js'

/**
 * 平台兼容：只剩一件事——按当前操作系统给出「连同子孙一起杀掉这个进程」的命令规格。
 *
 * 实例归调用方：无状态，平台由构造参数给（缺省取当前进程的平台）。
 */
export interface BrowserPlatformCompatibilityApi {
  /** 按当前平台给出「连同子孙一起杀掉这个进程」的命令规格。 */
  getProcessTreeKillCommandSpec(pid: number, signal: NodeJS.Signals): Nullable<BrowserCommandSpec>
}

export class BrowserPlatformCompatibility implements BrowserPlatformCompatibilityApi {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public getProcessTreeKillCommandSpec(
    pid: number,
    signal: NodeJS.Signals
  ): Nullable<BrowserCommandSpec> {
    if (this.platform !== 'win32') return null
    return {
      file: 'taskkill.exe',
      args: ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])],
    }
  }
}
