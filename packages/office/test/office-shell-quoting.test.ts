import { spawnSync } from 'node:child_process'

import { describe, expect, test } from 'bun:test'

import type { OfficeNativeCommand, OfficeToolContext } from '../src/exports'
import { officeConverters } from '../src/impl/operations/OfficeConverters'
import { describeOfficeNativeCommand } from '../src/utils/commands'
import { buildLatexCompileCommands } from '../src/utils/pdf/latex'

describe('Office 命令描述串', () => {
  test('每个参数都渲染成 JSON 字面量，注入片段不会变成 shell 语法', () => {
    const command: OfficeNativeCommand = {
      file: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      args: ["中文 O'Brien", '$HOME `printf injected` $(printf injected)', 'a"b\\c'],
    }
    const described = describeOfficeNativeCommand(command)

    expect(described).toBe(
      '"/Applications/LibreOffice.app/Contents/MacOS/soffice" "中文 O\'Brien" "$HOME `printf injected` $(printf injected)" "a\\"b\\\\c"'
    )
    // 反引号、$(...) 与引号全部落在 JSON 字面量里，描述串只用于展示与审批。
    for (const argument of command.args) expect(described).toContain(JSON.stringify(argument))
  })

  test('LibreOffice 调用把 FONTCONFIG_FILE 放进 env，不拼进命令串', async () => {
    const command: OfficeNativeCommand = { file: '/bin/echo', args: ['ok'] }
    let seen: Nullable<{ command: string; nativeCommand: OfficeNativeCommand }> = null
    const context = {
      office: {
        runCommand: async (native: OfficeNativeCommand, options: { description: string }) => {
          seen = { command: options.description, nativeCommand: native }
          return { success: true, exitCode: 0, stdout: '', stderr: '' }
        },
      },
    } as unknown as OfficeToolContext

    await officeConverters.runLibreOffice(context, command, process.cwd())

    expect(seen).not.toBeNull()
    const observed = seen as unknown as { command: string; nativeCommand: OfficeNativeCommand }
    expect(observed.command).not.toContain('FONTCONFIG_FILE=')
    expect(observed.nativeCommand.file).toBe(command.file)
    expect(observed.nativeCommand.args).toEqual(command.args)
    if (process.platform === 'darwin') {
      expect(observed.nativeCommand.env?.FONTCONFIG_FILE).toMatch(/velaros-office-fontconfig-/)
    }
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
      office: {
        runCommand: async (native: OfficeNativeCommand, options: { description: string }) => {
          expect(options.description).toBe(describeOfficeNativeCommand(native))
          expect(native).toEqual(nativeCommand)
          const result = spawnSync(native.file, native.args, { encoding: 'utf8' })
          return { success: result.status === 0, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
        },
      },
    } as unknown as OfficeToolContext
    const result = await officeConverters.runCommand(context, nativeCommand, process.cwd())
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
