#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPresent } from '@velaros-ai/core'

import { runServeCli } from './serve-cli'

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
): Promise<number> {
  if (!isPresent(argv[0]) || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write('VelarOS CLI\n\nCommands:\n  serve ...\n')
    process.exitCode = 0
    return 0
  }
  if (argv[0] !== 'serve') {
    process.stderr.write(`Unknown namespace: ${argv[0]}\n`)
    process.exitCode = 2
    return 2
  }
  const result = await runServeCli(argv.slice(1), { cwd })
  const stream = result.exitCode === 0 ? process.stdout : process.stderr
  stream.write(result.text)
  process.exitCode = result.exitCode
  return result.exitCode
}

const entry = process.argv[1]
if (isPresent(entry) && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
