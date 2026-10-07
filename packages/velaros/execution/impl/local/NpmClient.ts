import { mkdir, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

import { isEmpty, isObject } from '@velaros-ai/core'
import { AppError, createAbortError, createTimeoutError } from '@velaros-ai/core/error'

import { NpmExecutionLimits } from '../../contract/constants.js'
import type { NpmClientOptions } from '../../contract/requires.js'

/** 经宿主执行标准 npm；目录、Node、网络和进程回收均属于宿主。 */
export interface NpmClientApi {
  /** 安装暂存清单及指定包，保留锁文件并固定新增包的实际版本。 */
  install(
    directory: string,
    packages: readonly string[],
    allowScripts: boolean,
    signal: AbortSignal
  ): Promise<void>
  /** 按已有锁文件恢复完整生产依赖。 */
  restore(directory: string, allowScripts: boolean, signal: AbortSignal): Promise<void>
  /** 读取 npm 搜索的原始 JSON，领域负责投影有界结果。 */
  search(query: string, limit: number, signal: AbortSignal): Promise<unknown>
  /** 读取指定版本的元数据，不下载或执行包。 */
  describe(spec: string, signal: AbortSignal): Promise<unknown>
}

/** 标准 npm CLI 的唯一进程适配器。 */
class NpmClient implements NpmClientApi {
  public constructor(private readonly options: NpmClientOptions) {
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.cacheDirectory) ||
      (options.npmCli && !isAbsolute(options.npmCli))
    )
      throw new AppError('VALIDATION', 'npm 需要 Node、缓存与 CLI 的绝对路径')
  }

  public async install(
    directory: string,
    packages: readonly string[],
    allowScripts: boolean,
    signal: AbortSignal
  ): Promise<void> {
    await this.dependencies('install', directory, packages, allowScripts, signal)
  }

  public async restore(
    directory: string,
    allowScripts: boolean,
    signal: AbortSignal
  ): Promise<void> {
    await this.dependencies('ci', directory, [], allowScripts, signal)
  }

  private async dependencies(
    command: 'install' | 'ci',
    directory: string,
    packages: readonly string[],
    allowScripts: boolean,
    signal: AbortSignal
  ): Promise<void> {
    if (!isAbsolute(directory)) throw new AppError('VALIDATION', 'npm 安装目录需要绝对路径')
    await this.run(
      directory,
      [
        command,
        '--omit=dev',
        '--save-exact',
        '--package-lock=true',
        '--bin-links=true',
        '--engine-strict=true',
        '--install-strategy=nested',
        `--ignore-scripts=${!allowScripts}`,
        ...(allowScripts ? ['--dangerously-allow-all-scripts'] : []),
        ...(packages.length ? ['--', ...packages] : []),
      ],
      signal
    )
    await stat(join(directory, 'package-lock.json'))
  }

  public async search(query: string, limit: number, signal: AbortSignal): Promise<unknown> {
    return JSON.parse(
      await this.run(
        this.options.cacheDirectory,
        ['search', '--json', `--searchlimit=${limit}`, '--', query],
        signal
      )
    )
  }

  public async describe(spec: string, signal: AbortSignal): Promise<unknown> {
    return JSON.parse(
      await this.run(
        this.options.cacheDirectory,
        [
          'view',
          '--json',
          spec,
          'name',
          'version',
          'description',
          'engines',
          'dependencies',
          'peerDependencies',
          'bin',
          'homepage',
          'dist.integrity',
        ],
        signal
      )
    )
  }

  private async cli(): Promise<string> {
    if (this.options.npmCli) return realpath(this.options.npmCli)
    const paths = [
      dirname(this.options.executable),
      ...(this.options.environment?.PATH ?? process.env.PATH ?? '').split(delimiter),
    ]
    for (const root of paths.filter(Boolean)) {
      for (const candidate of [
        join(root, 'node_modules/npm/bin/npm-cli.js'),
        join(root, '../lib/node_modules/npm/bin/npm-cli.js'),
        join(root, 'npm'),
      ]) {
        try {
          const file = await realpath(candidate)
          if (file.endsWith('npm-cli.js')) return file
        } catch (error) {
          if (
            !isObject(error) ||
            !('code' in error) ||
            !['ENOENT', 'ENOTDIR'].includes(String(error.code))
          )
            throw error
        }
      }
    }
    throw new AppError(
      'UNAVAILABLE',
      '找不到 npm CLI；宿主可通过 npmCli 指定随产品分发的 npm-cli.js'
    )
  }

  private async run(
    directory: string,
    args: readonly string[],
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted()
    const cli = await this.cli()
    await mkdir(this.options.cacheDirectory, { recursive: true, mode: 0o700 })
    const result = await this.options.host.runCommand(
      'Manage agent npm environment',
      {
        cwd: directory,
        timeoutMs: NpmExecutionLimits.timeoutMs,
        maxOutputChars: NpmExecutionLimits.outputChars,
        environment: this.options.environment,
        nativeCommand: {
          file: this.options.executable,
          args: [
            cli,
            '--no-audit',
            '--no-fund',
            '--global=false',
            '--workspaces=false',
            `--cache=${this.options.cacheDirectory}`,
            ...args,
          ],
          env: {
            PATH: [
              dirname(this.options.executable),
              this.options.environment?.PATH ?? process.env.PATH,
            ]
              .filter(Boolean)
              .join(delimiter),
          },
        },
        onOutput: this.options.output,
      },
      false,
      signal
    )
    if (result.cleanupIncomplete)
      throw AppError.withFields('UNAVAILABLE', 'npm 进程树回收不完整，候选环境将保留供宿主核对', {
        cleanupIncomplete: true,
      })
    if (signal.aborted || result.aborted) throw createAbortError('npm 操作已取消')
    if (result.timedOut) throw createTimeoutError('npm 操作超时')
    if (result.signal || result.exitCode !== 0)
      throw new AppError(
        'UNAVAILABLE',
        `npm 执行失败（exit=${result.exitCode}）：${(result.stderr || result.stdout).slice(-NpmExecutionLimits.diagnosticChars)}`
      )
    if (result.truncated) throw new AppError('LIMIT', 'npm 输出超过上限，请缩小查询范围')
    return isEmpty(result.stdout.trim()) ? 'null' : result.stdout
  }
}

/** 复用宿主的授权、沙箱、取消与进程树回收。 */
export function createNpmClient(options: NpmClientOptions): NpmClientApi {
  return new NpmClient(options)
}
