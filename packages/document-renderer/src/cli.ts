#!/usr/bin/env node

import { executeRendererRequest } from './service'

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function parseRequestArgument(argv: readonly string[]): unknown | undefined {
  const requestIndex = argv.indexOf('--request-json')
  if (requestIndex < 0) return undefined
  const json = argv[requestIndex + 1]
  if (!json) throw new Error('--request-json requires one JSON object.')
  return JSON.parse(json)
}

export async function runDocumentRendererCli(
  argv: readonly string[],
  inputText?: string,
): Promise<{ exitCode: number; text: string }> {
  const requestFromArgument = parseRequestArgument(argv)
  const request = requestFromArgument ?? (argv[0] === 'describe'
    ? { protocolVersion: 1, requestId: 'describe', operation: 'describe' }
    : JSON.parse(inputText ?? await readStandardInput()))
  const response = await executeRendererRequest(request)
  return {
    exitCode: response.status === 'success' ? 0 : 1,
    text: `${JSON.stringify(response)}\n`,
  }
}

if (import.meta.main) {
  void runDocumentRendererCli(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(result.text)
      process.exitCode = result.exitCode
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
