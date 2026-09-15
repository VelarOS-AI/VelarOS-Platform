/**
 * 本机找不到任何能用的 shell 时抛的错误：`SystemShellUnavailableError`，错误码 `SYSTEM_SHELL_UNAVAILABLE`。
 * 不 import 任何 Node 模块，跨平台兼容层入口也导出它，渲染进程会加载。
 */

import { SystemErrorCodes } from '../contract/constants.js'

/** 本机找不到任何能用的 shell。外面按错误码 SYSTEM_SHELL_UNAVAILABLE 判断，不按文本。 */
export class SystemShellUnavailableError extends Error {
  public readonly code = SystemErrorCodes.shellUnavailable
  constructor(detail = '') {
    super(`找不到能用的命令 shell${detail ? `（${detail.trim()}）` : ''}。在 Windows 上安装 Git for Windows（https://git-scm.com/download/win），再刷新命令环境。`)
    this.name = 'SystemShellUnavailableError'
  }
}
