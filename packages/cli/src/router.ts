import { isFalse } from '@velaros-ai/core'

import { runAgentCli } from './agent.js'
import { formatVelarosCliError, formatVelarosCliSuccess } from './output.js'
import { runServeNamespace } from './serve.js'
import {
  VelarosCliError,
  type VelarosCliNamespaceRunResult,
  type VelarosCliRunOptions,
} from './types.js'

/**
 * 命名空间运行结果。
 *
 * `envelope` 刻意不钉死结构：它由各命名空间自持（见文件头导览的分叉说明），router 真正依赖的
 * 只有 `text` 与 `exitCode`。钉死了就只能靠 cast 骗过去（本文件曾经写的正是 `as unknown as`），
 * 等于把分叉从类型面藏进运行期。第三方命名空间甚至可以完全不给 envelope（`test/cli.test.mjs`
 * 注册的 `browser`/`custom` 就没有）。
 */
export type VelarosCliNamespaceRunner = (
  argv: string[],
  options: VelarosCliRunOptions,
) => Promise<VelarosCliNamespaceRunResult> | VelarosCliNamespaceRunResult

export interface CreateVelarosCliRouterOptions {
  /** Additional namespaces supplied by the product distribution. */
  namespaces?: Readonly<Record<string, VelarosCliNamespaceRunner>>
  /** Disable the bundled namespaces when composing a minimal third-party CLI. */
  includeBuiltinNamespaces?: boolean
  /** Deterministic clock injection for tests and embedded hosts. */
  now?: () => number
  /** Host-owned working-directory resolver; defaults to `process.cwd`. */
  resolveDefaultCwd?: () => string
}

const BuiltinNamespaceRunners: Readonly<Record<string, VelarosCliNamespaceRunner>> = {
  agent: runAgentCli,
  serve: runServeNamespace,
}

/**
 * Immutable, embeddable namespace router.
 *
 * The router owns composition only. Namespace implementations, process exit,
 * streams, and product state remain caller-owned.
 *
 * 导览（§5.3b ⑤跨层接缝 / ⑥非显然妥协）
 * - **方向铁律**：router → 命名空间是单向的，命名空间不认识 router、不许回调它。新增命名空间走
 *   `createVelarosCliRouter({ namespaces })` 注册，不改本文件；`BuiltinNamespaceRunners` 是产品
 *   默认集，不是准入白名单（`includeBuiltinNamespaces: false` 可整组关掉）。
 * - **router 只消费 `text` 与 `exitCode`**：stdout/stderr 与进程退出码由宿主（`cli.ts main()`）按
 *   这两个字段决定。`envelope` 是命名空间自持的结构化载荷，router 原样透出。
 * - **失败方向**：未知命名空间 → `UNKNOWN_NAMESPACE`（exitCode 2）；命名空间抛出的任何异常都在
 *   `run()` 内收成错误信封。router 自身永不向宿主抛——宿主拿到的永远是可打印结果。
 */
export class VelarosCliRouter {
  private readonly namespaceRunners: Readonly<Record<string, VelarosCliNamespaceRunner>>
  private readonly namespaces: readonly string[]
  private readonly now: () => number
  private readonly resolveDefaultCwd: () => string

  constructor(options: CreateVelarosCliRouterOptions = {}) {
    this.namespaceRunners = Object.freeze({
      ...(isFalse(options.includeBuiltinNamespaces) ? {} : BuiltinNamespaceRunners),
      ...options.namespaces,
    })
    this.namespaces = Object.freeze(Object.keys(this.namespaceRunners).sort())
    this.now = options.now ?? Date.now
    this.resolveDefaultCwd = options.resolveDefaultCwd ?? process.cwd
  }

  public listNamespaces(): readonly string[] {
    return this.namespaces
  }

  public async run(
    argv: string[],
    options: VelarosCliRunOptions = {},
  ): Promise<VelarosCliNamespaceRunResult> {
    const startedAt = this.now()
    const cwd = options.cwd ?? this.resolveDefaultCwd()
    const namespace = argv[0] ?? 'help'
    const json = argv.includes('--json')

    try {
      if (namespace === 'help' || namespace === '--help' || namespace === '-h')
        return formatVelarosCliSuccess({
          namespace: 'root',
          command: 'help',
          cwd,
          durationMs: this.now() - startedAt,
          result: { namespaces: this.namespaces },
          json,
          text: buildNamespaceHelp(this.namespaces),
        })

      const childArgv = argv.slice(1)
      const runNamespace = this.namespaceRunners[namespace]
      if (runNamespace) return await runNamespace(childArgv, { ...options, cwd })

      throw new VelarosCliError('UNKNOWN_NAMESPACE', `Unknown namespace: ${namespace}`, 2, {
        namespace,
        availableNamespaces: this.namespaces,
      })
    } catch (error) {
      return formatVelarosCliError(error, json)
    }
  }
}

export function createVelarosCliRouter(
  options: CreateVelarosCliRouterOptions = {},
): (argv: string[], runOptions?: VelarosCliRunOptions) => Promise<VelarosCliNamespaceRunResult> {
  const router = new VelarosCliRouter(options)
  return router.run.bind(router)
}

function buildNamespaceHelp(namespaces: readonly string[]): string {
  return `VelarOS CLI

Commands:
  help
${namespaces.map((namespace) => `  ${namespace} ...`).join('\n')}

Products can add non-tool operational namespaces through createVelarosCliRouter().
`
}

export const runVelarosCli = createVelarosCliRouter()
