/**
 * 本机找不到任何能用的 shell 时抛的错误：`SystemShellUnavailableError`，错误码 `SYSTEM_SHELL_UNAVAILABLE`。
 * 不 import 任何 Node 模块，跨平台兼容层入口也导出它，渲染进程会加载。
 */

import { SystemErrorCodes } from '../contract/system.js'

/** 本机找不到任何能用的 shell。错误文本已是公开契约，消费者按其中的英文片段断言。 */
export class SystemShellUnavailableError extends Error {
  public readonly code = SystemErrorCodes.shellUnavailable
  constructor(detail = '') {
    // @arch-guard:suspend code-style/require-chinese-comments 理由：该兼容错误文本已成为公开契约，现有消费者按英文片段断言。
    super(`No working command shell is available. ${detail} Install Git for Windows from https://git-scm.com/download/win and refresh the command environment.`)
    this.name = 'SystemShellUnavailableError'
  }
}
