#!/usr/bin/env node
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { main } from './cli/runner.js'

export type { RunWorkspaceCliOptions } from './cli/runner.js'
export { main, runWorkspaceCli } from './cli/runner.js'

function isDirectCliEntry(): boolean {
  const entry = process.argv[1]
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url)
}

if (isDirectCliEntry()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
