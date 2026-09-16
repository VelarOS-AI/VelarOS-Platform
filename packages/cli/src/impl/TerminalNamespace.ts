import { spawn } from 'node:child_process'
import { constants } from 'node:os'

import { isNotNull, readErrnoCode } from '@velaros-ai/core'
import { currentPlatform } from '@velaros-ai/platform'

import { VelarosCliErrorCodes, VelarosCliExitCodes } from '../contract/constants.js'
import type { VelarosCliNamespaceRunResult, VelarosCliRunOptions } from '../types/cli.js'
import { VelarosCliError } from '../utils/errors.js'

/**
 * `velaros terminal` 命名空间：启动独立发行的 Termel 产品。
 *
 * 本包只负责把参数原样交过去，不装配 Termel 的运行时、权限、数据根与 IPC；标准输入输出直通，
 * 子进程的退出码原样透出。整个进程共用 `terminalNamespace` 这一份。
 */
export interface TerminalNamespaceApi {
  /**
   * 起 Termel 子进程并等它结束：命令名取 `VELAROS_TERMEL_COMMAND`，不设时是 `termel`。
   * 找不到可执行文件时抛 `TERMEL_NOT_INSTALLED`（退出码 127）；子进程被信号杀死时给 128 加信号号。
   */
  run(
    argv: readonly string[],
    options: VelarosCliRunOptions,
  ): Promise<VelarosCliNamespaceRunResult>
}

export class TerminalNamespace implements TerminalNamespaceApi {
  /** 没设环境变量时启动的命令名；Termel 自己发行成这个名字。 */
  private static readonly DefaultCommand = 'termel'

  public async run(
    argv: readonly string[],
    options: VelarosCliRunOptions,
  ): Promise<VelarosCliNamespaceRunResult> {
    const environment = options.environment ?? process.env
    const command = environment.VELAROS_TERMEL_COMMAND?.trim() || TerminalNamespace.DefaultCommand

    return new Promise<VelarosCliNamespaceRunResult>((resolve, reject) => {
      // Windows 上 npm 装出来的是 termel.cmd 垫片，不经 shell 起不来（ENOENT / EINVAL）。
      const child = spawn(command, [...argv], {
        cwd: options.cwd,
        env: process.env,
        stdio: 'inherit',
        shell: currentPlatform.isWindows(),
      })

      child.once('error', (error) => {
        if (readErrnoCode(error) === 'ENOENT') {
          reject(new VelarosCliError(
            VelarosCliErrorCodes.termelNotInstalled,
            `没有找到 Termel 命令 ${command}。先安装 @velaros-ai/termel，或用 VELAROS_TERMEL_COMMAND 指定可执行文件。`,
            VelarosCliExitCodes.commandNotFound,
            { command },
          ))
          return
        }
        reject(error)
      })

      child.once('exit', (code, signal) => {
        // 被信号杀死时没有退出码，按 POSIX 惯例报 128 + 信号号，别把它和「正常退出 1」混成一档。
        const signalExitCode = isNotNull(signal)
          ? VelarosCliExitCodes.signalBase + constants.signals[signal]
          : VelarosCliExitCodes.ok
        resolve({ text: '', exitCode: code ?? signalExitCode })
      })
    })
  }
}

/** 整个进程共用的一份。 */
export const terminalNamespace: TerminalNamespaceApi = new TerminalNamespace()
