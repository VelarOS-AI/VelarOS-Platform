import { spawn } from 'node:child_process'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import {
  ComputerKernelModuleVersion,
  resolveBundledComputerRuntimeSourceRoot,
} from '@velaros-ai/computer/runtime'
import { isNotNull, isObject, Log, stringifyPretty } from '@velaros-ai/core'

const InstallMarkerName = '.velaros-computer-runtime.json'
const InstallerLog = Log.tag('VelarHostComputerInstaller')

export type VelarHostCommandRunner = (
  command: string,
  arguments_: readonly string[],
  cwd: string,
  onProgress?: (message: string) => void,
) => Promise<void>

export interface InstallVelarHostComputerOptions {
  readonly dataRoot: string
  readonly pythonCommand?: string
  readonly onProgress?: (message: string) => void
  /** Test/product seam; production uses argv-only child processes without a shell. */
  readonly runCommand?: VelarHostCommandRunner
}

export interface InstallVelarHostComputerResult {
  readonly installed: boolean
  readonly resourceRoot: string
  readonly packageRoot: string
  readonly pythonCommand: string
  readonly replacedPath: Nullable<string>
}

function helperScriptName(): string {
  switch (process.platform) {
    case 'darwin': return 'mac_helper.py'
    case 'win32': return 'win_helper.py'
    case 'linux': return 'linux_helper.py'
    default: throw new Error(`Computer control is unsupported on ${process.platform}`)
  }
}

function requirementsFile(): string {
  switch (process.platform) {
    case 'win32': return 'requirements-win.txt'
    case 'linux': return 'requirements-linux.txt'
    default: return 'requirements.txt'
  }
}

function venvPythonPath(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'venv', 'Scripts', 'python.exe')
    : join(root, 'venv', 'bin', 'python')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  // arch-guard:silent-catch-ok access 失败已记录，并被显式转换为“不存在”。
  } catch (error) {
    InstallerLog.debug('目标路径不可访问，按不存在处理。', { error, path })
    return false
  }
}

async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  onProgress?.(`${command} ${arguments_.join(' ')}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errorTail = ''
    child.stdout.on('data', (chunk) => onProgress?.(String(chunk).trim()))
    child.stderr.on('data', (chunk) => {
      errorTail = `${errorTail}${String(chunk)}`.slice(-8_000)
      onProgress?.(String(chunk).trim())
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(
        `${command} failed (${signal ?? `exit ${code ?? 'unknown'}`})${errorTail.trim() ? `: ${errorTail.trim()}` : ''}`,
      ))
    })
  })
}

async function resolvePython(
  configured: LooseOptional<string>,
  runCommand: VelarHostCommandRunner,
): Promise<string> {
  const explicit = configured?.trim() || process.env.VELAROS_COMPUTER_PYTHON?.trim()
  const candidates = explicit
    ? [explicit]
    : process.platform === 'win32'
      ? ['py', 'python']
      : ['python3', 'python']
  for (const candidate of candidates) {
    try {
      await runCommand(candidate, ['--version'], process.cwd())
      return candidate
    // arch-guard:silent-catch-ok 候选启动失败已记录，继续检查下一候选是预期流程。
    } catch (error) {
      InstallerLog.debug('Python 启动候选不可用，继续检查下一个候选。', {
        candidate,
        error,
      })
    }
  }
  throw new Error('Python 3 is required to install the Velar Host Computer runtime')
}

async function isCompleteInstallation(packageRoot: string): Promise<boolean> {
  if (
    !await exists(venvPythonPath(packageRoot))
    || !await exists(join(packageRoot, helperScriptName()))
  ) return false
  try {
    const marker: unknown = JSON.parse(
      await readFile(join(packageRoot, InstallMarkerName), 'utf8'),
    )
    return isObject(marker)
      && Reflect.get(marker, 'schemaVersion') === 1
      && Reflect.get(marker, 'platform') === process.platform
      && Reflect.get(marker, 'arch') === process.arch
  // arch-guard:silent-catch-ok 损坏标记已记录，并被显式转换为“不完整安装”。
  } catch (error) {
    InstallerLog.debug('Computer 运行时安装标记不可读，按不完整安装处理。', {
      error,
      packageRoot,
    })
    return false
  }
}

/** Installs an isolated Computer helper venv under this Host data root. */
export async function installVelarHostComputer(
  options: InstallVelarHostComputerOptions,
): Promise<InstallVelarHostComputerResult> {
  const resourceRoot = join(options.dataRoot, 'resources')
  const toolRoot = join(resourceRoot, 'computer-use')
  const packageRoot = join(toolRoot, `computeruse-${process.platform}-${process.arch}`)
  const runCommand = options.runCommand ?? run
  const existingPython = venvPythonPath(packageRoot)
  if (await isCompleteInstallation(packageRoot)) return {
      installed: false,
      resourceRoot,
      packageRoot,
      pythonCommand: existingPython,
      replacedPath: null,
    }

  const python = await resolvePython(options.pythonCommand, runCommand)
  await mkdir(toolRoot, { recursive: true, mode: 0o700 })
  const stagingRoot = await mkdtemp(join(toolRoot, '.computer-install-'))
  let replacedPath: Nullable<string> = null
  try {
    await cp(resolveBundledComputerRuntimeSourceRoot(), stagingRoot, { recursive: true })
    await runCommand(
      python,
      ['-m', 'venv', join(stagingRoot, 'venv')],
      stagingRoot,
      options.onProgress,
    )
    const isolatedPython = venvPythonPath(stagingRoot)
    await runCommand(
      isolatedPython,
      ['-m', 'pip', 'install', '-r', join(stagingRoot, requirementsFile())],
      stagingRoot,
      options.onProgress,
    )
    await writeFile(join(stagingRoot, 'package.json'), `${stringifyPretty({
      name: 'velaros-computer-runtime',
      version: ComputerKernelModuleVersion,
      private: true,
      platform: process.platform,
      arch: process.arch,
    })}\n`, { encoding: 'utf8', mode: 0o600 })
    await writeFile(join(stagingRoot, InstallMarkerName), `${stringifyPretty({
      schemaVersion: 1,
      version: ComputerKernelModuleVersion,
      platform: process.platform,
      arch: process.arch,
      installedAt: Date.now(),
    })}\n`, { encoding: 'utf8', mode: 0o600 })
    if (await exists(packageRoot)) {
      replacedPath = `${packageRoot}.incomplete-${Date.now()}`
      await rename(packageRoot, replacedPath)
    }
    await rename(stagingRoot, packageRoot)
    return {
      installed: true,
      resourceRoot,
      packageRoot,
      pythonCommand: venvPythonPath(packageRoot),
      replacedPath,
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    if (
      isNotNull(replacedPath)
      && !await exists(packageRoot)
      && await exists(replacedPath)
    ) await rename(replacedPath, packageRoot)
    throw error
  }
}

export function velarHostComputerResourceRoot(dataRoot: string): string {
  return join(dataRoot, 'resources')
}
