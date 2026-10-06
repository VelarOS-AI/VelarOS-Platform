/**
 * 受约束执行器：`ConfinedShellRunner`，接口 `ConfinedShellRunnerApi` 在本文件的类上方，由 `createConfinedShellRunner` 创建。
 * 把命令钉在一个根目录里跑：只许写这个根和它自己的临时目录，网络按建的时候的选择。演练沙箱的每个镜像根用一个。
 */

import { createPlatform } from '@velaros-ai/core/platform'

import type { ConfinedShellRunnerOptions } from '../../contract/requires.js'
import type { ShellCommandResult, ShellRunCommandOptions } from '../../types/shell-command.js'
import { buildConfinedSpawnSpec, confinedRootPolicy } from '../../utils/confinement.js'

import type { ShellCommandRunnerApi } from './ShellCommandRunner.js'
import { ShellCommandRunner } from './ShellCommandRunner.js'
import { shellProcessManager } from './ShellProcessManager.js'
import { shellResolver } from './ShellResolver.js'

/** 按配置建一个受约束执行器；这台宿主没有约束后端就在这里抛 `SHELL_CONFINEMENT_UNAVAILABLE`，一条命令都不让它裸跑。 */
export function createConfinedShellRunner(
  options: ConfinedShellRunnerOptions
): ConfinedShellRunnerApi {
  return new ConfinedShellRunner(options)
}

/**
 * 受约束执行器：命令的 cwd 固定是根目录，约束是 `workspace-write`、写根就是这个根加它自己的临时目录；
 * TMPDIR、TMP、TEMP 指进临时目录，git 不许交互式要口令。只跑前台命令，跑完就交回。
 *
 * 实现是 `ConfinedShellRunner`，里面是一个按这份约束配好的命令执行器；建的时候先探测约束后端，没有就拒绝。
 * 演练沙箱（`@velaros-ai/velaros/sandbox/local`）给每个镜像根建一个、丢弃时停掉。
 */
export interface ConfinedShellRunnerApi {
  /** 约束钉住的根目录（绝对路径），命令都在这里跑。 */
  readonly root: string
  /**
   * 在根目录里跑一条前台命令，返回完整回执；`options.background`、`options.interactive` 一律不理，照前台跑完。
   * 命令自己失败（非零退出、超时、取消）写进回执不抛错；写到根目录与临时目录之外的会被约束拦下。
   */
  run(
    command: string,
    options: ShellRunCommandOptions,
    abortSignal?: AbortSignal
  ): Promise<ShellCommandResult>
  /** 停掉在这里起的、还没退出的全部进程：先中止还在跑的命令、等它们收敛，再释放执行器；之后可以放心删根目录。 */
  dispose(): Promise<void>
}

export class ConfinedShellRunner implements ConfinedShellRunnerApi {
  public readonly root: string
  private readonly runner: ShellCommandRunnerApi
  /** 还在跑的命令：各自的中止开关与结束时刻，释放时先中止、再等它们收敛。 */
  private readonly running = new Set<{ controller: AbortController; settled: Promise<unknown> }>()

  constructor(options: ConfinedShellRunnerOptions) {
    const platform = options.platform ?? process.platform
    const policy = confinedRootPolicy(options.root, options.tempDir, options.network)
    // 先探测约束后端：没有就在这里拒绝，不给调用方留一个会裸跑的执行器。
    buildConfinedSpawnSpec(
      { spec: { file: 'true', args: [] }, policy },
      {
        platform,
        env: process.env,
        provider: options.confinementProvider,
        tempDir: options.tempDir,
      }
    )
    this.root = options.root
    this.runner = new ShellCommandRunner({
      platform,
      platformTools: createPlatform({ platform, env: process.env }),
      confinement: policy,
      confinementProvider: options.confinementProvider,
      confinementTempDir: options.tempDir,
      extraEnv: {
        TMPDIR: options.tempDir,
        TMP: options.tempDir,
        TEMP: options.tempDir,
        GIT_TERMINAL_PROMPT: '0',
      },
      shells: shellResolver,
      processes: shellProcessManager,
    })
  }

  public async run(
    command: string,
    options: ShellRunCommandOptions,
    abortSignal?: AbortSignal
  ): Promise<ShellCommandResult> {
    // 每条命令一个自己的中止开关：调用方取消时跟着停，释放执行器时也能停下它（前台命令不进后台任务表，执行器自己的释放管不到）。
    const controller = new AbortController()
    const forward = () => controller.abort(abortSignal?.reason)
    if (abortSignal?.aborted) forward()
    else abortSignal?.addEventListener('abort', forward, { once: true })
    const settled = this.runner.run(
      command,
      this.root,
      { ...options, background: false, interactive: false },
      controller.signal
    )
    const entry = { controller, settled }
    this.running.add(entry)
    try {
      return await settled
    } finally {
      abortSignal?.removeEventListener('abort', forward)
      this.running.delete(entry)
    }
  }

  public async dispose(): Promise<void> {
    const running = [...this.running]
    for (const entry of running) entry.controller.abort()
    await Promise.allSettled(running.map((entry) => entry.settled))
    await this.runner.dispose()
  }
}
