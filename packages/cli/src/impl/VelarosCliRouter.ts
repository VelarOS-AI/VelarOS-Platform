import { isFalse } from '@velaros-ai/core'

import { VelarosCliErrorCodes, VelarosCliExitCodes } from '../contract/constants.js'
import type { VelarosCliNamespaceRunner } from '../contract/requires.js'
import type { VelarosCliNamespaceRunResult, VelarosCliRunOptions } from '../types/cli.js'
import { normalizeVelarosCliError, VelarosCliError } from '../utils/errors.js'
import { buildErrorResult, buildRootHelpText, buildSuccessResult } from '../utils/output.js'

import { terminalNamespace } from './TerminalNamespace.js'

/** 造路由器时可以交代的东西，全部可选：不给就是「内置命名空间 + 本进程的时钟与当前目录」。 */
export interface VelarosCliRouterOptions {
  /** 产品自己的运维命名空间，键就是命令行上的第一段；同名时盖掉内置的那个。 */
  namespaces?: Readonly<Record<string, VelarosCliNamespaceRunner>>
  /** 传 false 就整组关掉内置命名空间，用来组一个只有产品命令的最小命令行。 */
  includeBuiltinNamespaces?: boolean
  /** 读时间的方式，测试与嵌入宿主可以换成确定的时钟；不给就是 `Date.now`。 */
  now?: () => number
  /** 没给 `cwd` 时从哪里取当前目录；不给就是 `process.cwd`。 */
  resolveDefaultCwd?: () => string
}

/**
 * 命令行路由器：只做组合——按第一段参数把调用交给对应的命名空间，自己不实现任何命令。
 *
 * 方向是单向的：路由器 → 命名空间，命名空间不认识路由器。命名空间实现、进程的标准输入输出与
 * 退出码都不归它管，它只给出可打印的结果。整个进程默认共用 `velarosCli` 这一份，产品要自己组一份
 * 就用 `createVelarosCliRouter`。
 */
export interface VelarosCliRouterApi {
  /** 已注册的命名空间名字，构造后冻结、按字典序；根帮助照它列。 */
  listNamespaces(): readonly string[]
  /**
   * 路由一次：第一段是命名空间名，`help`、`--help`、`-h` 与空参数走根帮助。
   * 未知的命名空间给 `UNKNOWN_NAMESPACE`（退出码 2），命名空间抛的异常收成 `EXECUTION_ERROR`（退出码 1）；
   * 本方法永不向宿主抛，拿到的永远是可打印结果。
   */
  run(
    argv: readonly string[],
    options?: VelarosCliRunOptions,
  ): Promise<VelarosCliNamespaceRunResult>
}

export class VelarosCliRouter implements VelarosCliRouterApi {
  /** 产品默认集，不是准入白名单：`includeBuiltinNamespaces: false` 可以整组关掉。 */
  private static readonly BuiltinNamespaces: Readonly<Record<string, VelarosCliNamespaceRunner>> =
    Object.freeze({
      terminal: (argv: readonly string[], options: VelarosCliRunOptions) =>
        terminalNamespace.run(argv, options),
    })

  /** 走根帮助的三种写法，外加「一个参数都不给」。 */
  private static readonly HelpAliases: ReadonlySet<string> = new Set(['help', '--help', '-h'])

  private readonly namespaceRunners: Readonly<Record<string, VelarosCliNamespaceRunner>>
  private readonly namespaces: readonly string[]
  private readonly now: () => number
  private readonly resolveDefaultCwd: () => string

  constructor(options: VelarosCliRouterOptions = {}) {
    const runners: Record<string, VelarosCliNamespaceRunner> = {}
    if (!isFalse(options.includeBuiltinNamespaces)) {
      Object.assign(runners, VelarosCliRouter.BuiltinNamespaces)
    }
    Object.assign(runners, options.namespaces)

    this.namespaceRunners = Object.freeze(runners)
    this.namespaces = Object.freeze(Object.keys(this.namespaceRunners).sort())
    this.now = options.now ?? Date.now
    this.resolveDefaultCwd = options.resolveDefaultCwd ?? process.cwd
  }

  public listNamespaces(): readonly string[] {
    return this.namespaces
  }

  public async run(
    argv: readonly string[],
    options: VelarosCliRunOptions = {},
  ): Promise<VelarosCliNamespaceRunResult> {
    const startedAt = this.now()
    const cwd = options.cwd ?? this.resolveDefaultCwd()
    const namespace = argv[0] ?? 'help'
    const json = argv.includes('--json')

    try {
      if (VelarosCliRouter.HelpAliases.has(namespace)) return buildSuccessResult({
          namespace: 'root',
          command: 'help',
          cwd,
          durationMs: this.now() - startedAt,
          result: { namespaces: this.namespaces },
          json,
          text: buildRootHelpText(this.namespaces),
        })

      const runNamespace = this.namespaceRunners[namespace]
      if (runNamespace) return await runNamespace(argv.slice(1), { ...options, cwd })

      throw new VelarosCliError(
        VelarosCliErrorCodes.unknownNamespace,
        `未知的命名空间：${namespace}。可用的是：${this.namespaces.join('、')}。`,
        VelarosCliExitCodes.usage,
        { namespace, availableNamespaces: this.namespaces },
      )
    } catch (error) {
      return buildErrorResult(normalizeVelarosCliError(error), json)
    }
  }
}

/** 按产品自己的命名空间组一份路由器；README 写给产品开发者的扩展点就是它。 */
export function createVelarosCliRouter(
  options: VelarosCliRouterOptions = {},
): VelarosCliRouterApi {
  return new VelarosCliRouter(options)
}

/** 带内置命名空间的那一份，`bin/velaros.mjs` 用的就是它。 */
export const velarosCli: VelarosCliRouterApi = new VelarosCliRouter()
