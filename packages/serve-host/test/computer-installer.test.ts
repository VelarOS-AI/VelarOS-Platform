import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  installVelarHostComputer,
  type VelarHostCommandRunner,
} from '../src/computer-installer'
import { runServeCli } from '../src/serve-cli'

function installedPython(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'venv', 'Scripts', 'python.exe')
    : join(root, 'venv', 'bin', 'python')
}

function venvPython(venvRoot: string): string {
  return process.platform === 'win32'
    ? join(venvRoot, 'Scripts', 'python.exe')
    : join(venvRoot, 'bin', 'python')
}

function helperScript(root: string): string {
  if (process.platform === 'darwin') return join(root, 'mac_helper.py')
  if (process.platform === 'win32') return join(root, 'win_helper.py')
  return join(root, 'linux_helper.py')
}

describe('Velar Host Computer runtime installer', () => {
  let temporaryRoot: string | undefined

  afterEach(async () => {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('installs into the Host data root, preserves incomplete data, and reuses complete installs', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-host-computer-install-'))
    const packageRoot = join(
      temporaryRoot,
      'resources',
      'computer-use',
      `computeruse-${process.platform}-${process.arch}`,
    )
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'unfinished.txt'), 'recoverable\n')

    const calls: Array<{ command: string; arguments_: readonly string[] }> = []
    const runCommand: VelarHostCommandRunner = async (command, arguments_) => {
      calls.push({ command, arguments_ })
      if (arguments_[0] === '--version') return
      if (arguments_[0] === '-m' && arguments_[1] === 'venv') {
        const python = venvPython(String(arguments_[2]))
        await mkdir(dirname(python), { recursive: true })
        await writeFile(python, '#!/usr/bin/env python3\n')
        return
      }
      if (arguments_[0] === '-m' && arguments_[1] === 'pip') return
      throw new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`)
    }

    const result = await installVelarHostComputer({
      dataRoot: temporaryRoot,
      pythonCommand: 'python-test',
      runCommand,
    })

    expect(result.installed).toBe(true)
    expect(result.packageRoot).toBe(packageRoot)
    expect(result.replacedPath).not.toBeNull()
    expect(await readFile(join(result.replacedPath!, 'unfinished.txt'), 'utf8'))
      .toBe('recoverable\n')
    expect(await stat(helperScript(packageRoot))).toBeDefined()
    expect(JSON.parse(await readFile(
      join(packageRoot, '.velaros-computer-runtime.json'),
      'utf8',
    )).schemaVersion).toBe(1)
    expect(calls.some(({ arguments_ }) => arguments_[1] === 'venv')).toBe(true)
    expect(calls.some(({ arguments_ }) => arguments_[1] === 'pip')).toBe(true)

    const reused = await installVelarHostComputer({
      dataRoot: temporaryRoot,
      runCommand: () => Promise.reject(new Error('must not spawn')),
    })
    expect(reused.installed).toBe(false)
    expect(reused.pythonCommand).toBe(installedPython(packageRoot))

    const cli = await runServeCli([
      'computer',
      'install',
      '--data-root',
      temporaryRoot,
      '--json',
    ])
    expect(cli.exitCode).toBe(0)
    expect(JSON.parse(cli.text).installed).toBe(false)
  })
})
