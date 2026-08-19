import {
  createVelarosCliRouter,
  type CreateVelarosCliRouterOptions,
  runVelarosCli,
  type VelarosCliNamespaceRunner,
  VelarosCliRouter,
} from './router.js'
import type { VelarosCliNamespaceRunResult } from './types.js'

export {
  createVelarosCliRouter,
  type CreateVelarosCliRouterOptions,
  runVelarosCli,
  type VelarosCliNamespaceRunner,
  type VelarosCliNamespaceRunResult,
  VelarosCliRouter,
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd()
): Promise<VelarosCliNamespaceRunResult> {
  const result = await runVelarosCli(argv, {
    cwd,
    write: (text) => process.stdout.write(text),
  })
  const stream = result.exitCode === 0 ? process.stdout : process.stderr
  stream.write(result.text)
  process.exitCode = result.exitCode
  return result
}
