#!/usr/bin/env node
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  runToolCollectionCli,
  type VelarosCliRunOptions,
  type VelarosCliRunResult,
} from '@velaros-ai/core/cli'
import { defaultDenyApprovalPort } from '@velaros-ai/core/tool-contract'

import { createLocalSystemKernel } from './kernel/LocalSystemKernel'
import { systemTools } from './Collection'
import type { SystemToolContext } from './Types'

export type { VelarosCliRunOptions as RunSystemToolsCliOptions }

export async function runSystemToolsCli(
  argv: string[],
  options: VelarosCliRunOptions = {}
): Promise<VelarosCliRunResult> {
  return runToolCollectionCli<SystemToolContext>(argv, {
    namespace: 'system',
    binName: 'velaros-system',
    tools: systemTools as any,
    cwd: options.cwd,
    createContext: ({ cwd }) => createLocalSystemToolContext(cwd),
  })
}

function createLocalSystemToolContext(cwd: string): SystemToolContext {
  const abortController = new AbortController()
  const system = createLocalSystemKernel({ cwd })
  return {
    abortSignal: abortController.signal,
    codingSession: {
      enableToolCategories: (categories) => categories,
      getEnabledToolCategories: () => ['system-control'],
    },
    // CLI 宿主无确认 UI:审批走设计式 deny 端口,需审批的敏感操作按宪章 §4 拒绝。
    approval: defaultDenyApprovalPort,
    execution: null,
    system,
  }
}

function isDirectCliEntry(): boolean {
  const entry = process.argv[1]
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url)
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd()
): Promise<VelarosCliRunResult> {
  const result = await runSystemToolsCli(argv, { cwd })
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
