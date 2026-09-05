import { spawn, spawnSync } from 'node:child_process'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const terminationGraceMs = 2_000
const killConfirmationMs = 1_000
const processPollMs = 25
const windowsTaskkillTimeoutMs = 5_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function resolveExistingDirectory(value, label, { rejectSymbolicLink = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty path`)
  }

  const absolutePath = path.resolve(value)
  if (rejectSymbolicLink) {
    let lexicalDetails
    try {
      lexicalDetails = await lstat(absolutePath)
    } catch (error) {
      throw new Error(`${label} must be an existing directory: ${absolutePath} (${errorMessage(error)})`)
    }
    if (lexicalDetails.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${absolutePath}`)
    }
  }

  let resolvedPath
  try {
    resolvedPath = await realpath(absolutePath)
  } catch (error) {
    throw new Error(`${label} must be an existing directory: ${absolutePath} (${errorMessage(error)})`)
  }

  const details = await stat(resolvedPath)
  if (!details.isDirectory()) {
    throw new Error(`${label} must be an existing directory: ${resolvedPath}`)
  }
  return resolvedPath
}

function containsPath(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath)
  return (
    relativePath === ''
    || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath)
    )
  )
}

async function resolveTemporaryRoots() {
  const roots = new Set()
  for (const candidate of ['/tmp', '/private/tmp', tmpdir()]) {
    try {
      roots.add(await realpath(path.resolve(candidate)))
    } catch {
      // A platform may not expose every conventional POSIX temporary path.
    }
  }
  return roots
}

async function assertSafeOutputDirectory(packageDirectory, outputDirectory, label) {
  const temporaryRoots = await resolveTemporaryRoots()
  if (temporaryRoots.has(outputDirectory)) {
    throw new Error(
      `${label} must not be a shared temporary root (${outputDirectory}); create a dedicated subdirectory`,
    )
  }

  const systemTemporaryRoot = await realpath(path.resolve(tmpdir()))
  if (!containsPath(systemTemporaryRoot, outputDirectory)) {
    throw new Error(
      `${label} must be inside a dedicated system temporary subdirectory: ${outputDirectory}`,
    )
  }

  if (
    containsPath(packageDirectory, outputDirectory)
    || containsPath(outputDirectory, packageDirectory)
  ) {
    throw new Error(
      `${label} must not overlap package source ${packageDirectory}: ${outputDirectory}`,
    )
  }
}

async function readLeafPackageManifest(packageDirectory) {
  const manifestPath = path.join(packageDirectory, 'package.json')
  let resolvedManifestPath
  try {
    resolvedManifestPath = await realpath(manifestPath)
  } catch (error) {
    throw new Error(`packageDirectory must contain package.json: ${manifestPath} (${errorMessage(error)})`)
  }

  if (!containsPath(packageDirectory, resolvedManifestPath)) {
    throw new Error(`package.json must resolve inside packageDirectory: ${resolvedManifestPath}`)
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(resolvedManifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`package.json must contain valid JSON: ${resolvedManifestPath} (${errorMessage(error)})`)
  }

  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    throw new Error(`package.json must contain a JSON object: ${resolvedManifestPath}`)
  }
  if (Object.hasOwn(manifest, 'workspaces')) {
    throw new Error(
      `packageDirectory must be a leaf package; workspace roots cannot be packed: ${packageDirectory}`,
    )
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    throw new Error(`package.json must declare a non-empty name: ${resolvedManifestPath}`)
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(`package.json must declare a non-empty version: ${resolvedManifestPath}`)
  }
  return manifest
}

async function validateOutputTarget({ destination, filename, packageDirectory }) {
  const hasDestination = destination !== undefined && destination !== null
  const hasFilename = filename !== undefined && filename !== null
  if (hasDestination === hasFilename) {
    throw new Error('Exactly one of destination or filename must be provided')
  }

  if (hasDestination) {
    const resolvedDestination = await resolveExistingDirectory(
      destination,
      'destination',
      { rejectSymbolicLink: true },
    )
    await assertSafeOutputDirectory(packageDirectory, resolvedDestination, 'destination')
    return { option: '--destination', value: resolvedDestination }
  }

  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new TypeError('filename must be a non-empty path')
  }
  const absoluteFilename = path.resolve(filename)
  if (path.extname(absoluteFilename) !== '.tgz') {
    throw new Error(`filename must end in .tgz: ${absoluteFilename}`)
  }

  const filenameParent = await resolveExistingDirectory(
    path.dirname(absoluteFilename),
    'filename parent',
    { rejectSymbolicLink: true },
  )
  await assertSafeOutputDirectory(packageDirectory, filenameParent, 'filename parent')
  const resolvedFilename = path.join(filenameParent, path.basename(absoluteFilename))

  try {
    const existingTarget = await lstat(resolvedFilename)
    if (existingTarget.isSymbolicLink()) {
      throw new Error(`filename must not be a symbolic link: ${resolvedFilename}`)
    }
    if (existingTarget.isDirectory()) {
      throw new Error(`filename must not be a directory: ${resolvedFilename}`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  return { option: '--filename', value: resolvedFilename }
}

function processGroupExists(child) {
  if (!child.pid) return false
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null
  }

  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

export function windowsTaskkillArguments(pid, { force = false } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError(`pid must be a positive safe integer; received ${pid}`)
  }
  return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
}

function taskkillFailureMessage(result) {
  const diagnostic = [result.stderr, result.stdout]
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .find(Boolean)
  if (diagnostic) return diagnostic
  if (result.error) return errorMessage(result.error)
  return `exit code ${result.status ?? 'unknown'}`
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return false
  try {
    if (process.platform === 'win32') {
      const force = signal === 'SIGKILL'
      const result = spawnSync(
        'taskkill.exe',
        windowsTaskkillArguments(child.pid, { force }),
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: windowsTaskkillTimeoutMs,
          windowsHide: true,
        },
      )
      if (result.status === 0) return true
      if (!processGroupExists(child)) return false
      if (!force && !result.error) {
        // Some console processes reject a graceful taskkill. Keep the process
        // alive through the grace period so the caller can escalate with /F.
        return true
      }
      throw new Error(
        `taskkill.exe could not stop Bun process tree ${child.pid}: ${taskkillFailureMessage(result)}`,
      )
    }
    process.kill(-child.pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw new Error(
      process.platform === 'win32'
        ? `Failed to stop Windows Bun process tree ${child.pid}: ${errorMessage(error)}`
        : `Failed to send ${signal} to Bun process group ${child.pid}: ${errorMessage(error)}`,
    )
  }
}

async function waitForProcessGroupExit(child, waitMs) {
  const deadline = Date.now() + waitMs
  while (processGroupExists(child)) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return false
    await delay(Math.min(processPollMs, remainingMs))
  }
  return true
}

async function terminateProcessGroup(child) {
  if (!signalProcessGroup(child, 'SIGTERM')) return { forced: false }
  if (await waitForProcessGroupExit(child, terminationGraceMs)) return { forced: false }

  signalProcessGroup(child, 'SIGKILL')
  if (!(await waitForProcessGroupExit(child, killConfirmationMs))) {
    throw new Error(`Bun process group ${child.pid} remained alive after SIGKILL`)
  }
  return { forced: true }
}

function outputText(chunks) {
  return Buffer.concat(chunks).toString('utf8')
}

function commandFailureMessage({ operation, code, signal, stdout, stderr }) {
  const status = signal ? `signal ${signal}` : `exit code ${code}`
  const diagnostic = stderr.trim() || stdout.trim()
  return [
    `${operation} failed with ${status}`,
    diagnostic ? `Command output:\n${diagnostic}` : '',
  ].filter(Boolean).join('\n')
}

function terminationDescription(forced) {
  if (process.platform === 'win32') {
    return forced
      ? `taskkill /T followed by taskkill /T /F after ${terminationGraceMs} ms`
      : 'taskkill /T'
  }
  return forced
    ? `SIGTERM followed by SIGKILL after ${terminationGraceMs} ms`
    : 'SIGTERM'
}

function processCollectionLabel() {
  return process.platform === 'win32' ? 'process tree' : 'process group'
}

export async function runGuardedCommand({
  command,
  args = [],
  cwd,
  env = process.env,
  operation = command,
  timeoutMs = 120_000,
  stdio = 'pipe',
} = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new TypeError('command must be a non-empty string')
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('args must be an array of strings')
  }
  if (typeof operation !== 'string' || operation.trim() === '') {
    throw new TypeError('operation must be a non-empty string')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`timeoutMs must be a positive safe integer; received ${timeoutMs}`)
  }
  if (typeof stdio !== 'string' && !Array.isArray(stdio)) {
    throw new TypeError('stdio must be a child_process stdio string or array')
  }

  const resolvedCwd = await resolveExistingDirectory(cwd, 'cwd')

  let child
  try {
    child = spawn(command, args, {
      cwd: resolvedCwd,
      detached: process.platform !== 'win32',
      env,
      stdio,
    })
  } catch (error) {
    throw new Error(
      `Failed to start ${operation}: ${errorMessage(error)}`,
    )
  }

  return await new Promise((resolve, reject) => {
    const stdoutChunks = []
    const stderrChunks = []
    let settled = false
    let timedOut = false
    let forwardedSignal
    let terminationPromise
    let timeoutHandle
    let closing = false

    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))

    const removeSignalHandlers = () => {
      process.removeListener('SIGINT', onSigint)
      process.removeListener('SIGTERM', onSigterm)
      process.removeListener('SIGHUP', onSighup)
    }
    const removeLifecycleHandlers = () => {
      removeSignalHandlers()
      process.removeListener('exit', onExit)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      removeLifecycleHandlers()
      callback(value)
    }
    const terminate = () => {
      terminationPromise ??= terminateProcessGroup(child)
      return terminationPromise
    }
    const forwardParentSignal = (signal) => {
      if (forwardedSignal || settled) return
      forwardedSignal = signal
      clearTimeout(timeoutHandle)
      void terminate()
        .catch((error) => error)
        .then((cleanupError) => {
          removeSignalHandlers()
          try {
            process.kill(process.pid, signal)
          } catch (error) {
            finish(
              reject,
              new Error(
                `Failed to restore parent ${signal} after cleaning ${operation}'s ${processCollectionLabel()}: ${errorMessage(error)}`,
              ),
            )
            return
          }
          setImmediate(() => {
            const cleanupDetails = cleanupError instanceof Error
              ? ` Cleanup error: ${cleanupError.message}`
              : ''
            finish(
              reject,
              new Error(`${operation} was interrupted by parent ${signal}.${cleanupDetails}`),
            )
          })
        })
    }
    const onSigint = () => forwardParentSignal('SIGINT')
    const onSigterm = () => forwardParentSignal('SIGTERM')
    const onSighup = () => forwardParentSignal('SIGHUP')
    const onExit = () => {
      if (settled) return
      try {
        if (processGroupExists(child)) signalProcessGroup(child, 'SIGKILL')
      } catch {
        // The process is already exiting; this is the final synchronous fallback.
      }
    }

    // Keep handlers installed during cleanup so a repeated signal cannot bypass
    // process-tree termination and orphan the command or its descendants.
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    process.on('SIGHUP', onSighup)
    process.once('exit', onExit)

    child.once('error', (error) => {
      finish(
        reject,
        new Error(
          `Failed to start ${operation}: ${errorMessage(error)}`,
        ),
      )
    })

    child.once('close', (code, signal) => {
      if (settled || timedOut || forwardedSignal || closing) return
      closing = true
      clearTimeout(timeoutHandle)
      void (async () => {
        try {
          if (processGroupExists(child)) await terminate()
        } catch (error) {
          finish(
            reject,
            new Error(
              `${operation} exited, but its remaining ${processCollectionLabel()} could not be stopped: ${errorMessage(error)}`,
            ),
          )
          return
        }

        if (settled || timedOut || forwardedSignal) return

        const stdout = outputText(stdoutChunks)
        const stderr = outputText(stderrChunks)
        if (code === 0 && signal === null) {
          finish(resolve, { code, signal, stdout, stderr })
          return
        }
        finish(
          reject,
          new Error(
            commandFailureMessage({
              operation,
              code,
              signal,
              stdout,
              stderr,
            }),
          ),
        )
      })()
    })

    timeoutHandle = setTimeout(() => {
      timedOut = true
      void terminate()
        .then(({ forced }) => {
          finish(
            reject,
            new Error(
              `${operation} timed out after ${timeoutMs} ms; ${processCollectionLabel()} ${child.pid ?? 'unknown'} was stopped with ${terminationDescription(forced)}`,
            ),
          )
        })
        .catch((error) => {
          finish(
            reject,
            new Error(
              `${operation} timed out after ${timeoutMs} ms, and cleanup failed: ${errorMessage(error)}`,
            ),
          )
        })
    }, timeoutMs)
  })
}

export async function safePackPackage({
  packageDirectory,
  destination,
  filename,
  timeoutMs = 120_000,
  stdio = 'pipe',
} = {}) {
  const resolvedPackageDirectory = await resolveExistingDirectory(
    packageDirectory,
    'packageDirectory',
  )
  await readLeafPackageManifest(resolvedPackageDirectory)
  const outputTarget = await validateOutputTarget({
    destination,
    filename,
    packageDirectory: resolvedPackageDirectory,
  })

  return await runGuardedCommand({
    args: [
      'pm',
      'pack',
      outputTarget.option,
      outputTarget.value,
      '--ignore-scripts',
      '--quiet',
    ],
    command: 'bun',
    cwd: resolvedPackageDirectory,
    operation: `Bun package pack for ${resolvedPackageDirectory}`,
    stdio,
    timeoutMs,
  })
}
