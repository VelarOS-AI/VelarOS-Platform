import { spawnSync } from 'node:child_process'

import { describe, expect, test } from 'bun:test'

import { OfficePlatformCompatibility } from '../src/OfficePlatformCompatibility'
import { describeOfficeNativeCommand, type OfficeNativeCommand, type OfficeToolContext, runOfficeSystemCommand } from '../src/officeShared'
import { buildLatexCompileCommands } from '../src/pdfTools'

describe('Office Bash command quoting', () => {
  test.skipIf(process.platform === 'win32')('preserves literal argument text through Bash on every platform', () => {
    const argument = "中文 O'Brien $HOME `printf injected` $(printf injected) \\n\nnext"
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const compatibility = new OfficePlatformCompatibility(platform)
      const result = spawnSync('/bin/bash', [
        '--noprofile', '--norc', '-c', `printf '%s' ${compatibility.quoteShellArg(argument)}`,
      ], { encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(result.stdout).toBe(argument)
    }
  })

  test('uses forward slashes only for Windows shell paths', () => {
    const windows = new OfficePlatformCompatibility('win32')
    const macOS = new OfficePlatformCompatibility('darwin')
    const executable = "C:\\Program Files\\中文 O'Brien\\tool.exe"

    expect(windows.quoteShellPath(executable)).toBe("'C:/Program Files/中文 O'\\''Brien/tool.exe'")
    expect(windows.quoteShellArg(executable)).toBe("'C:\\Program Files\\中文 O'\\''Brien\\tool.exe'")
    expect(macOS.quoteShellPath(executable)).toBe(macOS.quoteShellArg(executable))
  })
})

describe('Office native process bridge', () => {
  test('passes literal arguments and matching review text to the host without shell interpolation', async () => {
    const argumentsToEcho = ['中文🙂', '/container/path', '%PATH% !literal! "quotes" & $(echo injected)']
    const nativeCommand: OfficeNativeCommand = {
      file: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...argumentsToEcho],
    }
    const context = {
      office: { system: {
        runCommand: async (command: string, options: { nativeCommand: OfficeNativeCommand }) => {
          expect(command).toBe(describeOfficeNativeCommand(options.nativeCommand))
          expect(options.nativeCommand).toEqual(nativeCommand)
          const result = spawnSync(options.nativeCommand.file, options.nativeCommand.args, { encoding: 'utf8' })
          return { success: result.status === 0, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
        },
      } },
    } as unknown as OfficeToolContext
    const result = await runOfficeSystemCommand(context, nativeCommand, process.cwd())
    expect(result.success).toBe(true)
    expect(JSON.parse(result.stdout)).toEqual(argumentsToEcho)
  })

  test('LaTeX arguments preserve quote characters, percent signs, and Windows paths as raw argv', () => {
    const path = "C:\\Users\\中文 O'Brien\\100% !literal!"
    const commands = buildLatexCompileCommands({
      compiler: { name: 'xelatex', available: true, path: 'C:\\Program Files\\TeX\\xelatex.exe' },
      sourceFileName: "draft 'final'.tex", tempDir: path, runs: 2,
    })
    expect(commands).toHaveLength(2)
    expect(commands[0]).toEqual({
      file: 'C:\\Program Files\\TeX\\xelatex.exe',
      args: ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${path}`, "draft 'final'.tex"],
    })
  })
})
