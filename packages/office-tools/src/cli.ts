#!/usr/bin/env node
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  runToolCollectionCli,
  VelarosCliError,
  type VelarosCliRunOptions,
  type VelarosCliRunResult,
} from '@velaros-ai/core/cli'

import { officeTools } from './index'
import type { OfficeToolContext } from './officeShared'

export type { VelarosCliRunOptions as RunOfficeToolsCliOptions }

export async function runOfficeToolsCli(
  argv: string[],
  options: VelarosCliRunOptions = {}
): Promise<VelarosCliRunResult> {
  return runToolCollectionCli<OfficeToolContext>(argv, {
    namespace: 'office',
    binName: 'velaros-office',
    tools: officeTools as any,
    cwd: options.cwd,
    createContext: () => ({
      abortSignal: new AbortController().signal,
      hasWorkspaceRoot: () => false,
      workspace: createHostRequiredProxy('workspace') as any,
      system: createHostRequiredProxy('system') as any,
    }),
    resolveToolAvailability: ({ name }) => ({
      available: false,
      reason: 'host-runtime-required',
      message: `Tool requires host capability: ${name}`,
    }),
  })
}

function createHostRequiredProxy(capability: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, property) => async () => {
        throw new VelarosCliError(
          'HOST_CAPABILITY_REQUIRED',
          `The ${capability}.${String(property)} capability requires a VelarOS host runtime.`,
          1,
          { capability: `${capability}.${String(property)}` }
        )
      },
    }
  )
}

function isDirectCliEntry(): boolean {
  const entry = process.argv[1]
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url)
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd()
): Promise<VelarosCliRunResult> {
  const result = await runOfficeToolsCli(argv, { cwd })
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
