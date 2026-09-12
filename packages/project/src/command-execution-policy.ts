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

/** 递归删除的危险理由：点明删的是整个文件夹，用户确认时知道自己在批准什么。 */
const RecursiveRemoveReason = '该命令会递归删除整个文件夹及其中全部内容，删除后无法撤销。'
const DestructiveCommandReason = '该命令可能删除数据、破坏文件系统或终止关键进程。'
const PrivilegedMutationReason = '该命令会以提升权限批量修改系统资源。'

/**
 * Windows（cmd.exe / PowerShell）的递归删除形态，与 POSIX 的 `rm -r` 同一条线：删整个目录才危险，
 * 删单个文件（哪怕带 `-Force`、`/f`、`/q`）不拦。
 *
 * - PowerShell `Remove-Item -Recurse` 及别名 ri/del/erase/rd/rmdir；参数名可按唯一前缀缩写，
 *   `-r`、`-rec` 都是 `-Recurse`，也可写成 `-Recurse:$true`。`rm` 不在这里：它由
 *   `hasRecursiveRemove` 按词法判定（同时认 POSIX 与 PowerShell 写法，并保留 `git rm` 例外）。
 * - cmd.exe `rd /s`、`rmdir /s`、`del /s`：开关前面须是空白、命令名或上一个开关
 *   （`rd /s /q`、`rmdir/s/q`），路径里的 `docs/s.md` 不算开关。
 *
 * 命令名和参数在 Windows 侧都不区分大小写（`RD /S` 等价于 `rd /s`），所以这里各自带 `/i`。
 */
const windowsRecursiveRemovePatterns: readonly RegExp[] = [
  // 命令名前不能是 `-`：`git branch --del -r` 里的 `--del` 不是删除命令。
  /(?<![-\w])(?:del|erase|rd|rmdir|ri|remove-item)\b[^&|;\r\n]*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?=[\s:]|$)/i,
  /(?<![-\w])(?:del|erase|rd|rmdir)\b[^&|;\r\n]*(?:\s|(?<=\b(?:del|erase|rd|rmdir)|\/[a-z]))\/s\b/i,
]

/**
 * Windows 下其余破坏性命令形态。单杠参数要求前面紧跟空白（而非 `--force` 里的第二个 `-`），
 * 避免跟 `del dist --force`（如 del-cli 清理脚本）、`npm run format` 这类常见跨平台命令误撞。
 */
const windowsDestructivePatterns: readonly RegExp[] = [
  // 删除命令的目标落在注册表根路径（PowerShell 的 HKLM: 等驱动器）视同破坏性删除。
  /\b(?:del|erase|rd|rmdir|ri|rm|remove-item)\b[^&|;\r\n]*\b(?:hklm|hkcu|hkcr|hku|hkcc|hkey_[a-z_]+)\b/i,
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

/** 长参数按 GNU getopt 的唯一前缀规则匹配：`--rec` 即 `--recursive`，至少要写到 `--` 后一个字母。 */
function matchesLongOption(argument: string, option: string): boolean {
  return argument.length >= 3 && option.startsWith(argument)
}

/**
 * 读出 `rm` 之后的删除参数。单杠参数分两种写法：只由 POSIX rm 短选项字母（d f i r v）组成的是
 * 选项簇（`-rf`、`-R`），逐字母判定；其余是 PowerShell 参数名（`-Recurse`、`-Force`、`-Verbose`），
 * 按参数名前缀判定——否则 `-Force` 里的 r 会被误当成递归。
 */
function readRemoveFlags(args: readonly string[]): { recursive: boolean, force: boolean } {
  let recursive = false
  let force = false
  for (const argument of args) {
    if (argument === '--') break
    const normalized = argument.toLowerCase()
    if (normalized.startsWith('--')) {
      recursive ||= matchesLongOption(normalized, '--recursive')
      force ||= matchesLongOption(normalized, '--force')
    } else if (/^-[dfirv]+$/.test(normalized)) {
      recursive ||= normalized.includes('r')
      force ||= normalized.includes('f')
    } else if (normalized.length > 1 && normalized.startsWith('-')) {
      // `-Recurse:$true` 这类带值写法只看冒号前的参数名；`-f` 在 PowerShell 里有歧义，至少写到 `-fo`。
      const parameter = normalized.split(':')[0] ?? normalized
      recursive ||= parameter.length > 1 && '-recurse'.startsWith(parameter)
      force ||= parameter.length > 2 && '-force'.startsWith(parameter)
    }
  }
  return { recursive, force }
}

/** 段内 `git` 子命令所在的词位；不是 git 命令或找不到子命令时为 -1。 */
function findGitSubcommandTokenIndex(tokens: readonly string[]): number {
  const executableIndex = tokens.findIndex((token) => !/^[A-Za-z_]\w*=/.test(token))
  if (executableIndex < 0 || tokens[executableIndex]?.split('/').at(-1)?.toLowerCase() !== 'git') return -1
  const subcommandIndex = findGitSubcommandIndex(tokens.slice(executableIndex + 1))
  return subcommandIndex < 0 ? -1 : executableIndex + 1 + subcommandIndex
}

/**
 * 递归删除（`rm -r` / `-R` / `--recursive` / PowerShell `rm -Recurse`，不论是否带 `-f`）会整棵删掉
 * 目录，既不进回收站也不在项目事务里，恢复不了——所以一律判危险。非递归的 `rm file` 只删单个文件，
 * 不拦。`rm` 出现在段内任意位置都算（`sudo rm -r`、`xargs rm -r`、`find … -exec rm -r`）。
 *
 * `git rm` 例外：它只删已跟踪且与索引一致的文件（有未提交修改时 git 自己拒绝），内容能从 git
 * 取回；只有叠加 `-f` 强制删掉未提交修改时才判危险。
 */
function hasRecursiveRemove(command: string): boolean {
  return command.split(/&&|\|\||[;|\r\n]/).some((segment) => {
    const tokens = tokenize(segment.trim())
    const gitSubcommandIndex = findGitSubcommandTokenIndex(tokens)
    return tokens.some((token, index) => {
      if (token.split('/').at(-1)?.toLowerCase() !== 'rm') return false
      const flags = readRemoveFlags(tokens.slice(index + 1))
      return index === gitSubcommandIndex ? flags.recursive && flags.force : flags.recursive
    })
  })
}

/** 命令的危险理由；不危险为 null。递归删除单列理由，其余破坏性与提权命令沿用通用文案。 */
function describeDangerousCommand(command: string): Nullable<string> {
  if (hasRecursiveRemove(command) || windowsRecursiveRemovePatterns.some((pattern) => pattern.test(command)))
    return RecursiveRemoveReason
  if (
    /\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bkill\s+-9\s+-1\b/i.test(command)
    || windowsDestructivePatterns.some((pattern) => pattern.test(command))
  ) return DestructiveCommandReason
  if (
    /\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b/i.test(command)
    || windowsPrivilegedMutationPatterns.some((pattern) => pattern.test(command))
  ) return PrivilegedMutationReason
  return null
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

  const dangerousReason = describeDangerousCommand(trimmed)
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
