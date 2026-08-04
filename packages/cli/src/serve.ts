import { toNullable } from '@velaros-ai/core'

import { formatVelarosCliError, formatVelarosCliSuccess } from './output.js'
import { VelarosCliError, type VelarosCliNamespaceRunResult } from './types.js'

/**
 * `serve-host` owns Host behavior; this adapter only turns its neutral result into the
 * official `velaros` output contract. The dynamic import keeps help/agent startup light.
 */
export async function runServeNamespace(
  argv: string[],
  options: { cwd?: string } = {},
): Promise<VelarosCliNamespaceRunResult> {
  const startedAt = Date.now()
  const json = argv.includes('--json')
  const cwd = options.cwd ?? process.cwd()
  const { runServeCli } = await import('@velaros-ai/serve-host/cli')
  const result = await runServeCli(argv, { cwd })

  if (result.error)
    return formatVelarosCliError(
      new VelarosCliError(
        result.error.code,
        result.error.message,
        result.exitCode,
        result.error.details,
      ),
      json,
    )

  return formatVelarosCliSuccess({
    namespace: 'serve',
    command: result.command,
    cwd,
    durationMs: Date.now() - startedAt,
    result: toNullable(result.envelope),
    json,
    text: result.text,
    exitCode: result.exitCode,
  })
}
