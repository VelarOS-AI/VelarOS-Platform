import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

export class RendererPathDeniedError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'RendererPathDeniedError'
  }
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function requireInside(root: string, target: string, label: string): void {
  if (!isInside(root, target)) {
    throw new RendererPathDeniedError(`${label} is outside projectRoot.`)
  }
}

export async function resolveRendererPaths(input: {
  readonly projectRoot: string
  readonly inputPath: string
  readonly outputPath: string
}): Promise<{ projectRoot: string; inputPath: string; outputPath: string }> {
  const projectRoot = await realpath(resolve(input.projectRoot))
  const requestedInput = resolve(projectRoot, input.inputPath)
  const requestedOutput = resolve(projectRoot, input.outputPath)
  requireInside(projectRoot, requestedInput, 'inputPath')
  requireInside(projectRoot, requestedOutput, 'outputPath')

  const inputPath = await realpath(requestedInput)
  requireInside(projectRoot, inputPath, 'inputPath')

  const outputDirectory = dirname(requestedOutput)
  await mkdir(outputDirectory, { recursive: true })
  const realOutputDirectory = await realpath(outputDirectory)
  requireInside(projectRoot, realOutputDirectory, 'outputPath')
  try {
    const outputStats = await lstat(requestedOutput)
    if (outputStats.isSymbolicLink()) {
      throw new RendererPathDeniedError('outputPath must not be a symbolic link.')
    }
    requireInside(projectRoot, await realpath(requestedOutput), 'outputPath')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }

  return {
    projectRoot,
    inputPath,
    outputPath: resolve(realOutputDirectory, basename(requestedOutput)),
  }
}
