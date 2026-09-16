/**
 * 平台兼容：只剩一件事——按当前操作系统给出「连同子孙一起杀掉这个进程」的命令规格。
 *
 * 实例归进程：无状态，一份就够。
 */
import type { BrowserCommandSpec } from '../../types/browser.js'

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
