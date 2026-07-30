#!/usr/bin/env node
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createVelarosCliRouter,
  type CreateVelarosCliRouterOptions,
  runVelarosCli,
  type VelarosCliNamespaceRunner,
  type VelarosCliNamespaceRunResult,
  VelarosCliRouter,
} from './router.js'

export {
  createVelarosCliRouter,
  type CreateVelarosCliRouterOptions,
  runVelarosCli,
  type VelarosCliNamespaceRunner,
  type VelarosCliNamespaceRunResult,
  VelarosCliRouter,
}

function isDirectCliEntry(): boolean {
  const entry = process.argv[1]
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url)
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd()
): Promise<VelarosCliNamespaceRunResult> {
  const result = await runVelarosCli(argv, { cwd })
  const stream = result.exitCode === 0 ? process.stdout : process.stderr
  stream.write(result.text)
  process.exitCode = result.exitCode
  return result
}

if (isDirectCliEntry()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
