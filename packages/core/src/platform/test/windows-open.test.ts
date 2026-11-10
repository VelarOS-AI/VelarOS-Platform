import { spawnSync } from 'node:child_process'

import { expect, test } from 'bun:test'

import { createPlatform } from '../index.js'
import type { CommandSpec } from '../types/platform.js'

/** 只解析生成的 PowerShell，不执行关联打开；可选用隐藏、可回收的自身运行时回传实际 argv。 */
function inspectOpenSpec(spec: CommandSpec, echo = false) {
  expect(spec.args.slice(0, -1)).toEqual([
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
  ])
  expect(spec.windowsVerbatimArguments).toBeUndefined()
  const encoded = spec.args.at(-1)!
  const fixture = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid generated PowerShell' }
$shell = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left -is [System.Management.Automation.Language.MemberExpressionAst] -and
  $node.Left.Member.Value -eq 'UseShellExecute'
}, $true))
if ($shell.Count -ne 1) { throw 'Expected graphical shell association' }
$shellValue = $shell[0].Right.Find({ param($node)
  $node -is [System.Management.Automation.Language.VariableExpressionAst]
}, $true)
if ($shellValue.VariablePath.UserPath -ne 'true') { throw 'Expected graphical shell association' }
$fields = @{}
foreach ($name in @('FileName', 'Arguments')) {
  $assignments = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [System.Management.Automation.Language.MemberExpressionAst] -and
    $node.Left.Member.Value -eq $name
  }, $true))
  if ($assignments.Count -ne 1) { throw 'Expected one literal field assignment' }
  $literals = @($assignments[0].Right.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.StringConstantExpressionAst]
  }, $true))
  if ($literals.Count -ne 1) { throw 'Expected one literal value' }
  $fields[$name] = $literals[0].Value
}
if (${echo ? '$true' : '$false'}) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $fields.FileName
  $start.Arguments = $fields.Arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = [Diagnostics.Process]::Start($start)
  try {
    if (-not $child.WaitForExit(3000)) { throw 'Argument fixture exceeded its deadline' }
    if ($child.ExitCode -ne 0) { throw $child.StandardError.ReadToEnd() }
    $child.StandardOutput.ReadToEnd()
  } finally {
    if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(1000) }
    $child.Dispose()
  }
} else { $fields | ConvertTo-Json -Compress }
`
  const result = spawnSync(
    spec.file,
    [...spec.args.slice(0, -1), Buffer.from(fixture, 'utf16le').toString('base64')],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      killSignal: 'SIGKILL',
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout.trim())
}

test.skipIf(process.platform !== 'win32')(
  'Windows open preserves external association targets as literal data',
  () => {
    const platform = createPlatform({ platform: 'win32', env: { ComSpec: 'untrusted.exe' } })
    for (const target of [
      'https://example.invalid/?a=1&b=%25&c=$HOME#part',
      'C:\\folder & percent%\\中文 雪😀.txt',
      "C:\\a'b\\literal $(value) ` | ^.txt",
    ]) {
      const fields = inspectOpenSpec(platform.getOpenExternalFallbackSpec(target))
      expect(fields).toEqual({ FileName: target, Arguments: '' })
    }
  },
  30000
)

test.skipIf(process.platform !== 'win32')(
  'Windows open preserves target-first native application argv',
  () => {
    const platform = createPlatform({ platform: 'win32' })
    const args = [
      '',
      'a b',
      'quoted "value"',
      'C:\\with space\\',
      '\\\\"',
      'a&b|c^%PATH%',
      "$HOME ` ' $(literal)",
      '中文😀',
      'line\r\nnext',
    ]
    // targetPath 在 args 之前；使用 -e 让这个无 GUI 的小进程只回传参数，不打开用户文件。
    const spec = platform.getOpenApplicationCommandSpec(
      process.execPath,
      ['process.stdout.write(JSON.stringify(process.argv))', '--', ...args],
      '-e'
    )
    const actual = inspectOpenSpec(spec, true) as string[]
    expect(actual.slice(-args.length)).toEqual(args)
  },
  12000
)

test('Windows open rejects NUL instead of allowing native path truncation', () => {
  const platform = createPlatform({ platform: 'win32' })
  expect(() => platform.getOpenExternalFallbackSpec('target\0suffix')).toThrow(
    expect.objectContaining({ code: 'VALIDATION' })
  )
  expect(() => platform.getOpenApplicationCommandSpec('app.exe', ['arg\0suffix'])).toThrow(
    expect.objectContaining({ code: 'VALIDATION' })
  )
})
