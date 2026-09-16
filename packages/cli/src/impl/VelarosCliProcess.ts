import { AppError, Log } from '@velaros-ai/core'

import { VelarosCliExitCodes } from '../contract/constants.js'
import type { VelarosCliEnvironment } from '../types/cli.js'

import { velarosCli, type VelarosCliRouterApi } from './VelarosCliRouter.js'

const log = Log.tag('VelarosCli')

/** 可执行文件交进来的进程上下文：只有进程原始参数与环境两样。 */
export interface VelarosCliProcessContext {
  /** `process.argv` 原样；前两项（node 与脚本路径）由本类剥掉。 */
  readonly argv: readonly string[]
  /** `process.env` 原样；命名空间要读的变量都从这里取。 */
  readonly environment: VelarosCliEnvironment
}

/**
 * `velaros` 可执行文件的唯一能力：把进程参数与环境交给路由器，写标准输出／标准错误，算出退出码。
 *
 * 判参数、读环境、决定退出码都在这里，`bin/velaros.mjs` 只是几行壳。整个进程共用 `velarosCliProcess` 这一份。
 */
export interface VelarosCliProcessApi {
  /**
   * 跑一次命令行：结果文本按退出码分流（0 走 stdout，非 0 走 stderr），返回进程该用的退出码。
   * 自己不调 `process.exit`，也永不向外抛——路由器之外的意外异常收成退出码 1 并在 stderr 写一句中文。
   */
  run(context: VelarosCliProcessContext): Promise<number>
}

export class VelarosCliProcess implements VelarosCliProcessApi {
  constructor(private readonly router: VelarosCliRouterApi) {}

  public async run(context: VelarosCliProcessContext): Promise<number> {
    try {
      // process.argv 的前两项固定是 node 与脚本路径，命令行参数从第三项开始。
      const result = await this.router.run(context.argv.slice(2), {
        environment: context.environment,
      })
      const stream = result.exitCode === VelarosCliExitCodes.ok ? process.stdout : process.stderr
      if (result.text) stream.write(result.text)
      return result.exitCode
    } catch (error) {
      // 路由器承诺不抛，走到这里说明是它之外的意外；写一行 stderr 让用户看见，日志留给宿主的采集面。
      log.error('命令行抛出了未预期的异常', { error })
      process.stderr.write(`velaros 执行失败：${AppError.getMessage(error)}\n`)
      return VelarosCliExitCodes.failure
    }
  }
}

/** 整个进程共用的一份，接的是带内置命名空间的默认路由器。 */
export const velarosCliProcess: VelarosCliProcessApi = new VelarosCliProcess(velarosCli)
