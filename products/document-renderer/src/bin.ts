#!/usr/bin/env bun
import { dirname } from 'node:path'

async function main(): Promise<void> {
  const resourcesRoot = dirname(process.execPath)
  process.env.VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT ??= resourcesRoot
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH ??= `${resourcesRoot}/canvas.node`
  const { runDocumentRendererCli } =
    await import('../../../packages/document-renderer/src/cli')
  const result = await runDocumentRendererCli(process.argv.slice(2))
  process.stdout.write(result.text)
  process.exitCode = result.exitCode
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
