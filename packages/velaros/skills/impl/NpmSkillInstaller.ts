import { stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

import { isObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { SkillLimits } from '../contract/constants.js'
import type { NpmSkillInstallerOptions, SkillDependencyInstaller } from '../contract/requires.js'

/** 标准包管理器运行在暂存目录；成功后安装器仍由收据校验完整依赖。 */
class NpmSkillInstaller implements SkillDependencyInstaller {
  public constructor(private readonly options: NpmSkillInstallerOptions) {
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.npmCli) ||
      !isAbsolute(options.cacheDirectory)
    )
      throw new AppError('VALIDATION', 'Skill 安装器需要 Node 与 npm CLI 的绝对路径')
  }

  public async install(
    directory: string,
    allowScripts: boolean,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    let locked = true
    try {
      await stat(join(directory, 'package-lock.json'))
    } catch (error) {
      if (!isObject(error) || !('code' in error) || error.code !== 'ENOENT') throw error
      locked = false
    }
    const result = await this.options.host.runCommand(
      'Install Skill dependencies',
      {
        cwd: directory,
        timeoutMs: SkillLimits.installTimeoutMs,
        nativeCommand: {
          file: this.options.executable,
          env: { PATH: `${dirname(this.options.executable)}${delimiter}${process.env.PATH ?? ''}` },
          args: [
            this.options.npmCli,
            locked ? 'ci' : 'install',
            '--omit=dev',
            '--no-audit',
            '--no-fund',
            '--package-lock=true',
            '--install-strategy=nested',
            `--cache=${this.options.cacheDirectory}`,
            ...(allowScripts ? [] : ['--ignore-scripts']),
          ],
        },
      },
      false,
      signal
    )
    signal.throwIfAborted()
    if (result.exitCode !== 0 || result.aborted || result.timedOut || result.cleanupIncomplete)
      throw new AppError(
        'UNAVAILABLE',
        `Skill 依赖安装失败：${result.stderr || result.stdout || result.exitCode}`
      )
    await stat(join(directory, 'package-lock.json'))
  }
}

/** 复用标准 npm 的锁文件、依赖解析和完整性校验。 */
export function createNpmSkillInstaller(
  options: NpmSkillInstallerOptions
): SkillDependencyInstaller {
  return new NpmSkillInstaller(options)
}
