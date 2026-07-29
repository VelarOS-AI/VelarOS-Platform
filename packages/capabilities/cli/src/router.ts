import {
  formatVelarosCliError,
  formatVelarosCliSuccess,
  VelarosCliError,
  type VelarosCliRunOptions,
  type VelarosCliRunResult,
} from '@velaros-ai/core/cli'
import { runOfficeToolsCli } from '@velaros-ai/office-tools/cli'
import { runSystemToolsCli } from '@velaros-ai/system-tools/cli'
import { runWorkspaceCli } from '@velaros-ai/workspace/cli'

import { runAgentCli } from './agent.js'

export type VelarosCliNamespaceRunner = (
  argv: string[],
  options: VelarosCliRunOptions,
) => Promise<VelarosCliRunResult> | VelarosCliRunResult

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
  workspace: async (argv, options) =>
    (await runWorkspaceCli(argv, options)) as unknown as VelarosCliRunResult,
  system: runSystemToolsCli,
  office: runOfficeToolsCli,
  agent: runAgentCli,
}

/**
 * Immutable, embeddable namespace router.
 *
 * The router owns composition only. Namespace implementations, process exit,
 * streams, and product state remain caller-owned.
 */
export class VelarosCliRouter {
  private readonly namespaceRunners: Readonly<Record<string, VelarosCliNamespaceRunner>>
  private readonly namespaces: readonly string[]
  private readonly now: () => number
  private readonly resolveDefaultCwd: () => string

  constructor(options: CreateVelarosCliRouterOptions = {}) {
    this.namespaceRunners = Object.freeze({
      ...(options.includeBuiltinNamespaces === false ? {} : BuiltinNamespaceRunners),
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
  ): Promise<VelarosCliRunResult> {
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
      if (runNamespace) return await runNamespace(childArgv, { cwd })

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
): (argv: string[], runOptions?: VelarosCliRunOptions) => Promise<VelarosCliRunResult> {
  const router = new VelarosCliRouter(options)
  return router.run.bind(router)
}

function buildNamespaceHelp(namespaces: readonly string[]): string {
  return `VelarOS CLI

Commands:
  help
${namespaces.map((namespace) => `  ${namespace} ...`).join('\n')}

Products can add Browser, Memory, Computer, or other namespaces through createVelarosCliRouter().
`
}

export const runVelarosCli = createVelarosCliRouter()
