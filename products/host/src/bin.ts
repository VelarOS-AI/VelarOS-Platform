#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const HostResourcesEnvironment = 'VELAROS_HOST_RESOURCES_ROOT'

function packagedResourcesRoot(): string {
  const configured = process.env[HostResourcesEnvironment]?.trim()
  if (configured) return resolve(configured)

  const executableDirectory = dirname(process.execPath)
  switch (process.platform) {
    case 'darwin':
      return resolve(executableDirectory, '..')
    case 'win32':
      return join(executableDirectory, 'resources')
    case 'linux':
      return resolve(executableDirectory, '..', 'share', 'velar-host')
    default:
      return resolve(executableDirectory, 'resources')
  }
}

function normalizeArguments(
  argv: string[],
  defaultProjectRoot: string,
): string[] {
  const withoutNamespace = argv[0] === 'serve' ? argv.slice(1) : [...argv]
  const first = withoutNamespace[0]
  const startsHost = !first || first === 'start' || first.startsWith('-')
  if (
    !startsHost ||
    withoutNamespace.includes('--project-root') ||
    withoutNamespace.includes('--workspace-root')
  ) return withoutNamespace
  return [...withoutNamespace, '--project-root', defaultProjectRoot]
}

async function main(): Promise<void> {
  const resourcesRoot = packagedResourcesRoot()
  process.env.VELAROS_COMPUTER_RUNTIME_SOURCE_ROOT = join(
    resourcesRoot,
    'computer-runtime',
  )
  process.env.VELAROS_PDFJS_STANDARD_FONTS_ROOT = join(
    resourcesRoot,
    'pdfjs-standard-fonts',
  )

  const defaultProjectRoot =
    process.env.VELAROS_HOST_PROJECT_ROOT?.trim() || join(homedir(), 'VelarOS')
  await mkdir(defaultProjectRoot, { recursive: true })

  const { runServeCli } =
    await import('../../../packages/serve-host/src/serve-cli')
  const result = await runServeCli(
    normalizeArguments(process.argv.slice(2), defaultProjectRoot),
    {
      cwd: defaultProjectRoot,
      onEvent: (message) =>
        process.stdout.write(message.endsWith('\n') ? message : `${message}\n`),
    },
  )
  process.stdout.write(result.text)
  process.exitCode = result.exitCode
}

if (import.meta.main) {
  void main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}

export { normalizeArguments, packagedResourcesRoot }
