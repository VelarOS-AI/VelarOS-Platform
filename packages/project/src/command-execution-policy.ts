import { isEmpty, isString, isTrue } from '@velaros-ai/core'

export interface CommandExecutionPlan {
  isReadOnly: boolean
  shouldRequestConfirmation: boolean
  shouldStartInBackground: boolean
  reason: Nullable<string>
  isDangerous: boolean
  dangerousReason: Nullable<string>
  ports: number[]
}

const readOnlyCommands = new Set([
  'cat', 'cut', 'date', 'df', 'du', 'env', 'find', 'git', 'grep', 'head', 'id', 'ls',
  'pwd', 'rg', 'sed', 'stat', 'tail', 'tree', 'uname', 'wc', 'which', 'whoami',
  // Windows（cmd.exe / PowerShell）只读读法。可执行名在查表前已统一 toLowerCase()
  // （见下方 isShellCommandReadOnly），按小写登记即可；PowerShell 命令名本就
  // 不区分大小写。ls/cat/pwd 等 POSIX 名同时也是 PowerShell 内置别名，重合是有意的。
  'dir', 'type', 'findstr', 'where', 'gci', 'get-childitem', 'get-content', 'gc',
  'get-item', 'gi', 'select-string', 'sls', 'test-path',
])
const readOnlyGitCommands = new Set([
  'annotate', 'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap',
  'check-ref-format', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index',
  'diff-tree', 'for-each-ref', 'grep', 'help', 'log', 'ls-files', 'ls-remote', 'ls-tree',
  'merge-base', 'name-rev', 'range-diff', 'rev-list', 'rev-parse', 'shortlog', 'show',
  'show-branch', 'status', 'verify-commit', 'verify-pack', 'verify-tag', 'version',
  'whatchanged',
])
const gitGlobalOptionsWithValue = new Set([
  '-C', '-c', '--config-env', '--git-dir', '--namespace', '--work-tree',
])
const gitGlobalOptionsWithoutValue = new Set([
  '-p', '-P', '--bare', '--glob-pathspecs', '--icase-pathspecs', '--literal-pathspecs',
  '--no-advice', '--no-lazy-fetch', '--no-optional-locks', '--no-pager',
  '--no-replace-objects', '--noglob-pathspecs', '--paginate',
])
const gitGlobalOptionsWithInlineValue = [
  '--config-env=', '--exec-path=', '--git-dir=', '--namespace=', '--work-tree=',
] as const

/**
 * Windows（cmd.exe / PowerShell）下与下面两条 POSIX 黑名单对应的破坏性命令形态。
 *
 * 命令名和参数在 Windows 侧都不区分大小写（`DEL /F` 等价于 `del /f`），但 POSIX 那两条
 * 正则不能因此改成不区分大小写——`RM -RF` 根本不是真实存在的 POSIX 命令，改了会让既有
 * 判定的语义悄悄漂移，因此这里单独开一组、各自带 `/i`。单杠参数要求前面紧跟空白
 * （而非 `--force` 里的第二个 `-`），避免跟 `del dist --force`（如 del-cli 清理脚本）、
 * `npm run format` 这类常见跨平台命令误撞。
 */
const windowsDestructivePatterns: readonly RegExp[] = [
  // del/erase/rd/rmdir 是 cmd.exe 原生命令；PowerShell 里 rm/ri/remove-item 同样是
  // Remove-Item 的别名，强制/递归参数或目标落在注册表根路径都视同破坏性删除。
  /\b(?:del|erase|rd|rmdir|ri|rm|remove-item)\b[^&|;\r\n]*(?:\s-(?:recurse|force)\b|\/[fsq]\b|\b(?:hklm|hkcu|hkcr|hku|hkcc|hkey_[a-z_]+)\b)/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b|\bvssadmin\s+delete\b|\bbcdedit\b|\bbootrec\b/i,
  /\breg\s+delete\b|\bremove-itemproperty\b/i,
  /\bcipher\b[^&|;\r\n]*\/w\b|\bsdelete(?:64)?\b/i,
  /\brestart-computer\b|\bstop-computer\b/i,
]

const windowsPrivilegedMutationPatterns: readonly RegExp[] = [
  /\brunas\b|\bstart-process\b[^&|;\r\n]*\s-verb(?:\s+|:)['"]?runas\b/i,
  /\btakeown\b|\bicacls\b[^&|;\r\n]*\/reset\b/i,
  // `icacls ... /grant` 单独出现很常见且通常无害（给单个文件加一条权限）；只有再叠加
  // 递归 `/t` 才逼近"对根目录批量改权限"，因此用双 lookahead 要求二者同现、不论先后。
  /\bicacls\b(?=[^&|;\r\n]*\/grant\b)(?=[^&|;\r\n]*\/t\b)/i,
]

function tokenize(command: string): string[] {
  return command.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g)?.map((token) =>
    token.replace(/^(['"])(.*)\1$/, '$2')
  ) ?? []
}

function hasInlineGitGlobalOptionValue(token: string): boolean {
  if (token.startsWith('-C') && token.length > 2) return true
  if (token.startsWith('-c') && token.length > 2 && token.includes('=')) return true
  return gitGlobalOptionsWithInlineValue.some((prefix) =>
    token.startsWith(prefix) && token.length > prefix.length
  )
}

function findGitSubcommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token) return -1
    if (token === '--') {
      const subcommand = args[index + 1]
      return subcommand && !subcommand.startsWith('-') ? index + 1 : -1
    }
    if (!token.startsWith('-')) return index
    if (gitGlobalOptionsWithValue.has(token)) {
      if (!args[index + 1]) return -1
      index += 1
      continue
    }
    if (gitGlobalOptionsWithoutValue.has(token) || hasInlineGitGlobalOptionValue(token)) continue
    return -1
  }
  return -1
}

function hasMutatingGitArguments(args: readonly string[]): boolean {
  return args.some((argument) => argument === '--output' || argument.startsWith('--output='))
}

function hasDangerousRecursiveForceRemove(command: string): boolean {
  return command.split(/&&|\|\||[;|\r\n]/).some((segment) => {
    const tokens = tokenize(segment.trim())
    return tokens.some((token, index) => {
      if (token.split('/').at(-1)?.toLowerCase() !== 'rm') return false
      let recursive = false
      let force = false
      for (const argument of tokens.slice(index + 1)) {
        if (argument === '--') break
        const normalizedArgument = argument.toLowerCase()
        if (normalizedArgument === '--recursive') recursive = true
        if (normalizedArgument === '--force') force = true
        if (argument.startsWith('-') && !argument.startsWith('--')) {
          const shortOptions = normalizedArgument.slice(1)
          recursive ||= shortOptions.includes('r')
          force ||= shortOptions.includes('f')
        }
        if (recursive && force) return true
      }
      return false
    })
  })
}

function extractPorts(command: string): number[] {
  const ports = new Set<number>()
  for (const match of command.matchAll(/(?:--port(?:=|\s+)|(?:^|\s)-p\s+|:)(\d{2,5})\b/g)) {
    const port = Number(match[1])
    if (port > 0 && port <= 65_535) ports.add(port)
  }
  return [...ports]
}

export function isShellCommandReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[\r\n><`$()]|(^|[^&])&([^&]|$)/.test(trimmed)) return false
  return trimmed.split(/&&|\|\||;|\|/).every((segment) => {
    const tokens = tokenize(segment.trim())
    const executableIndex = tokens.findIndex((token) => !/^[A-Za-z_]\w*=/.test(token))
    if (executableIndex < 0) return false
    const executable = tokens[executableIndex]?.split('/').at(-1)?.toLowerCase()
    if (!executable || !readOnlyCommands.has(executable)) return false
    if (executable === 'git') {
      const args = tokens.slice(executableIndex + 1)
      const subcommandIndex = findGitSubcommandIndex(args)
      if (subcommandIndex < 0) return false
      const subcommand = args[subcommandIndex]
      return !!subcommand
        && readOnlyGitCommands.has(subcommand)
        && !hasMutatingGitArguments(args.slice(subcommandIndex + 1))
    }
    return !/\b(?:delete|exec|okdir|remove|write)\b/i.test(segment)
  })
}

export function isShellCommandLikelyMutating(command: string): boolean {
  return !isShellCommandReadOnly(command)
}

export function analyzeCommandExecution(command: string): CommandExecutionPlan {
  const trimmed = command.trim()
  if (!trimmed) return {
    isReadOnly: false,
    shouldRequestConfirmation: false,
    shouldStartInBackground: false,
    reason: null,
    isDangerous: false,
    dangerousReason: null,
    ports: [],
  }

  const dangerousReason =
    hasDangerousRecursiveForceRemove(trimmed)
      || /\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bkill\s+-9\s+-1\b/i.test(trimmed)
      || windowsDestructivePatterns.some((pattern) => pattern.test(trimmed))
      ? '该命令可能删除数据、破坏文件系统或终止关键进程。'
      : /\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b/i.test(trimmed)
          || windowsPrivilegedMutationPatterns.some((pattern) => pattern.test(trimmed))
        ? '该命令会以提升权限批量修改系统资源。'
        : null
  const reason =
    /(?:^|\s)(?:dev|serve|server|watch|start)(?:\s|$)|\b(?:vite|webpack-dev-server|next\s+dev)\b|(^|[^&])&\s*$/i.test(trimmed)
      ? '该命令看起来会启动长期驻留的服务或监听进程。'
      : null

  return {
    isReadOnly: isShellCommandReadOnly(trimmed),
    shouldRequestConfirmation: !!dangerousReason || !!reason,
    shouldStartInBackground: !!reason,
    reason,
    isDangerous: !!dangerousReason,
    dangerousReason,
    ports: extractPorts(trimmed),
  }
}

export function isParallelCommandExecutionSafe(input: {
  command?: unknown
  background?: unknown
  parallel?: unknown
}): boolean {
  if (!isTrue(input.parallel) || isTrue(input.background) || !isString(input.command)) return false
  const plan = analyzeCommandExecution(input.command)
  return plan.isReadOnly
    && !plan.shouldRequestConfirmation
    && !plan.shouldStartInBackground
    && !plan.isDangerous
}

export const isParallelCommandSafe = isParallelCommandExecutionSafe

export function buildBackgroundCommandConfirmationMessage(
  command: string,
  plan: CommandExecutionPlan,
  scopeLabel: string,
  willRunInBackground: boolean
): string {
  const portSuffix = !isEmpty(plan.ports) ? ` 可能涉及端口：${plan.ports.join(', ')}。` : ''
  if (plan.isDangerous) return [
      `准备在${scopeLabel}执行高风险命令：${command}`,
      plan.dangerousReason ?? '该命令可能造成不可逆结果。',
      willRunInBackground ? `该命令还可能长期驻留。${portSuffix}` : '这是一次需要显式确认的危险操作。',
      '是否继续？',
    ].join('\n')
  return [
    `准备在${scopeLabel}启动一个可能长期驻留的命令：${command}`,
    plan.reason ?? '该命令可能会保持后台运行。',
    `执行后可手动终止。${portSuffix}`,
    '是否继续？',
  ].join('\n')
}

export const buildBackgroundCommandNotice = buildBackgroundCommandConfirmationMessage
