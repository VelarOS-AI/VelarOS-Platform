import { isEmpty, isNull, isString, isTrue, toNullable } from '@velaros-ai/core'

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
/** cmd.exe `del /q`：安静模式只在目标是文件夹或通配符时才起作用，那时会不提示地删掉其中全部文件。 */
const QuietBulkDeleteReason = '该命令以安静模式删除，目标是文件夹或通配符时会不经确认删掉其中全部文件，删除后无法撤销。'
/** `find … -delete`：在整棵目录树里批量删除匹配到的文件。 */
const TreeDeleteReason = '该命令会在整个目录树里批量删除匹配到的文件，删除后无法撤销。'
/** 用 Git 里的版本覆盖工作区：未提交的改动从没进过 Git，覆盖后找不回来。 */
const GitDiscardReason = '该命令会用 Git 里的版本覆盖工作区，未提交的改动会永久丢失。'
const GitCleanReason = '该命令会删除未被 Git 跟踪的文件，它们从未提交过，删除后无法恢复。'
const GitStashDropReason = '该命令会永久丢弃 Git stash 里暂存的改动。'
const DestructiveCommandReason = '该命令可能删除数据、破坏文件系统或终止关键进程。'
const PrivilegedMutationReason = '该命令会以提升权限批量修改系统资源。'

/**
 * Windows 下其余破坏性命令形态（删除类命令由 `describeInvocationDanger` 按词法判定）。单杠参数要求
 * 前面紧跟空白（而非 `--force` 里的第二个 `-`），避免跟 `npm run format` 这类常见跨平台命令误撞。
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

/**
 * 命令段分隔：控制操作符（`&&` `||` `;` `|` `&` 换行）与子 shell、命令替换、代码块的边界
 * （`(` `)` `$(` 反引号 `{` `}`）。每段开头都是一个新的命令位置，`(rm -r dir)`、`$(rm -r dir)`、
 * `find … -exec rm -r {} \;`、PowerShell `ForEach-Object { Remove-Item $_ -Recurse }` 里的删除命令都落在
 * 段首。切分不理会引号：危险判定宁可因为引号里碰巧写着删除命令多问一次，也不能漏掉真会执行的写法。
 */
const CommandSegmentSeparator = /&&|\|\||[;|&()`{}\r\n]/

/** 出现在命令词之前、不改变「执行的是哪条命令」的 shell 保留字。 */
const ShellReservedWords = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])

/**
 * 把后面的词当作一条新命令执行的前缀命令，值是它们「取值写在下一个词里」的选项：
 * `sudo -u root rm -r dir`、`xargs -n 1 rm -r`、`nice -n 5 rm -r dir` 里的 rm 都在命令位置上。
 * `timeout` 另有一个位置参数（时长）。表外的长选项取值写法（`--user root`）会让判定停在取值上，
 * 前缀命令用到它们的机会很少，按漏判接受。
 */
const CommandPrefixes: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['builtin', new Set<string>()],
  ['busybox', new Set<string>()],
  ['caffeinate', new Set(['-t', '-w'])],
  ['command', new Set<string>()],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '--unset', '--chdir'])],
  ['exec', new Set(['-a'])],
  ['ionice', new Set(['-c', '-n', '-p'])],
  ['nice', new Set(['-n'])],
  ['nohup', new Set<string>()],
  ['setsid', new Set<string>()],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U', '--user', '--group', '--chdir'])],
  ['time', new Set(['-f', '-o'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['xargs', new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--max-args', '--max-procs'])],
])

/** 用 `-c <命令文本>` 执行一段脚本的 POSIX shell。 */
const PosixShells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish'])

/** 既是 cmd.exe 内置删除命令、又是 PowerShell Remove-Item 别名的名字：`/s` 与 `-Recurse` 两种写法都认。 */
const CmdRemoveCommands = new Set(['del', 'erase', 'rd', 'rmdir'])

/**
 * GNU coreutils、BSD/macOS 与 busybox `rm` 全部短选项字母（d f i I P R r v W x）的并集。只由它们组成的
 * 单杠参数是 POSIX 选项簇（`-rf`、`-Rx`、`-rP`），逐字母判定；其余单杠参数按 PowerShell 参数名判定
 * （PowerShell 里 `rm` 是 Remove-Item 的别名，`-Force` 里的 r 不代表递归）。这是封闭集合：簇里混进其他
 * 字母时 rm 以 illegal option 退出、一个文件都不删，按 PowerShell 读法放行不会漏掉真正的删除。
 * 字母按大小写不敏感匹配：`RM -RF /` 这种大写写法按意图同样判危险。
 */
const PosixRemoveOptionCluster = /^-[dfiprvwx]+$/i

/** cmd.exe 开关串：`/s`、`/S`、`/s/q`、`/a:h`。`/tmp/s` 这类路径每段不止一个字母，不是开关。 */
const CmdSwitchToken = /^(?:\/[a-z](?::[a-z-]*)?)+$/i

/** 命令位置上的一次调用：规范化后的命令名与它在本段内的实参。 */
interface ShellInvocation {
  name: string
  args: string[]
}

/**
 * 命令词的规范名：去掉路径前缀（`/bin/rm`、`C:\tools\rm.exe`，也去掉绕过别名的 `\rm` 的反斜杠）与
 * Windows 的 `.exe`，统一小写——macOS 默认文件系统大小写不敏感，`RM` 同样执行 /bin/rm；Windows 命令
 * 本就不分大小写。
 */
function commandName(token: string): string {
  return (token.split(/[/\\]/).at(-1) ?? token).toLowerCase().replace(/\.exe$/, '')
}

/** 跳过前缀命令自己的选项（连同取值）与 `timeout` 的时长，返回被它执行的命令词所在位置。 */
function skipPrefixArguments(name: string, tokens: readonly string[], start: number): number {
  const optionsWithValue = CommandPrefixes.get(name) ?? new Set<string>()
  let index = start
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (token === '--') return index + 1
    if (token.length < 2 || !token.startsWith('-')) break
    index += optionsWithValue.has(token) ? 2 : 1
  }
  return name === 'timeout' ? index + 1 : index
}

/**
 * 读出段内命令位置上的调用：跳过环境变量赋值、shell 保留字与前缀命令，剩下的第一个词才是真正执行的
 * 命令——`pnpm rm -r lodash` 里的 rm 是 pnpm 的子命令，不是删除命令。cmd.exe 允许开关紧贴命令名
 * （`rmdir/s/q build`），拆成命令名加开关。
 */
function readInvocation(tokens: readonly string[]): Nullable<ShellInvocation> {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (/^[A-Za-z_]\w*=/.test(token) || ShellReservedWords.has(token)) {
      index += 1
      continue
    }
    const glued = /^(del|erase|rd|rmdir)((?:\/[^/]*)+)$/i.exec(token)
    if (glued) {
      const switches = (glued[2] ?? '').split('/').filter(Boolean).map((part) => `/${part}`)
      return { name: (glued[1] ?? '').toLowerCase(), args: [...switches, ...tokens.slice(index + 1)] }
    }
    const name = commandName(token)
    if (!CommandPrefixes.has(name)) return { name, args: tokens.slice(index + 1) }
    index = skipPrefixArguments(name, tokens, index + 1)
  }
  return null
}

/** 长参数按 GNU getopt 的唯一前缀规则匹配：`--rec` 即 `--recursive`，至少要写到 `--` 后一个字母。 */
function matchesLongOption(argument: string, option: string): boolean {
  return argument.length >= 3 && option.startsWith(argument)
}

/**
 * PowerShell 参数名能否表示 `parameter`：参数名大小写不敏感、可按唯一前缀缩写（`-r`、`-rec` 都是
 * `-Recurse`），也可写成 `-Recurse:$true`；`-Recurse:$false` 是显式关闭。
 */
function matchesPowerShellParameter(argument: string, parameter: string, minimumLength: number): boolean {
  const [name = '', value] = argument.toLowerCase().split(':', 2)
  return value !== '$false' && name.length >= minimumLength && parameter.startsWith(name)
}

/** 实参里有没有 PowerShell 的 `-Recurse`（含缩写与 `:$true` 写法）。 */
function hasPowerShellRecurse(args: readonly string[]): boolean {
  return args.some((argument) => matchesPowerShellParameter(argument, '-recurse', 2))
}

/** `rm` 的删除参数：POSIX 选项簇、GNU 长选项与 PowerShell 参数名三种写法都认，`--` 之后是路径。 */
function readRemoveFlags(args: readonly string[]): { recursive: boolean, force: boolean } {
  let recursive = false
  let force = false
  for (const argument of args) {
    if (argument === '--') break
    if (argument.startsWith('--')) {
      const normalized = argument.toLowerCase()
      recursive ||= matchesLongOption(normalized, '--recursive')
      force ||= matchesLongOption(normalized, '--force')
    } else if (PosixRemoveOptionCluster.test(argument)) {
      recursive ||= /[Rr]/.test(argument)
      force ||= /f/i.test(argument)
    } else if (argument.length > 1 && argument.startsWith('-')) {
      // `-f` 在 PowerShell 里有歧义（-Filter / -Force），至少写到 `-fo` 才是 -Force。
      recursive ||= matchesPowerShellParameter(argument, '-recurse', 2)
      force ||= matchesPowerShellParameter(argument, '-force', 3)
    }
  }
  return { recursive, force }
}

/** 实参里的 cmd.exe 开关字母（小写）：`/s /q`、`/s/q` 都拆成 s 与 q。 */
function readCmdSwitches(args: readonly string[]): Set<string> {
  const switches = new Set<string>()
  for (const argument of args) {
    if (!CmdSwitchToken.test(argument)) continue
    for (const part of argument.split('/')) {
      if (part) switches.add(part.charAt(0).toLowerCase())
    }
  }
  return switches
}

/**
 * 解释器以参数形式执行的那段命令文本：`bash -c '…'`、`eval …`、`powershell -Command …`、`cmd /c …`。
 * 这段文本整体重新判定，`sh -c 'rm -rf dir'` 与直接写 `rm -rf dir` 同样危险。不是这种调用返回 null。
 */
function readInlineScript(invocation: ShellInvocation): Nullable<string> {
  const { name, args } = invocation
  if (name === 'eval') return args.join(' ')
  if (PosixShells.has(name)) {
    const flagIndex = args.findIndex((argument) =>
      /^-[A-Za-z]*c[A-Za-z]*$/.test(argument) || argument === '--command')
    return flagIndex < 0 ? null : toNullable(args.slice(flagIndex + 1).find((argument) => !argument.startsWith('-')))
  }
  if (name === 'powershell' || name === 'pwsh') {
    const flagIndex = args.findIndex((argument) => matchesPowerShellParameter(argument, '-command', 2))
    return flagIndex < 0 ? null : args.slice(flagIndex + 1).join(' ')
  }
  if (name === 'cmd') {
    const flagIndex = args.findIndex((argument) => /^\/[ck]$/i.test(argument))
    return flagIndex < 0 ? null : args.slice(flagIndex + 1).join(' ')
  }
  return null
}

/** 选项在 `--` 之前出现：长选项（含 `--x=value`）或合写的短选项簇（`-fdx` 同时带 f、d、x）。区分大小写。 */
function hasGitOption(args: readonly string[], short: Nullable<string>, long: string): boolean {
  const options = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  return options.some((argument) =>
    argument === long
    || argument.startsWith(`${long}=`)
    || (isString(short) && /^-[A-Za-z]+$/.test(argument) && argument.includes(short)))
}

/**
 * Git 子命令的危险理由，与项目写入同一条线——能不能恢复。切分支、合并、变基、撤提交、普通推送都能从
 * reflog 找回，不拦；下面这些丢的是从没进过 Git 的内容（工作区改动、未跟踪文件）或只存一份的 stash：
 *
 * - `reset --hard` / `--merge` 把工作区改写成目标提交（`--keep` 遇到会丢的本地改动时 Git 自己中止，不拦）；
 * - `restore` 默认写工作区，只有纯 `--staged`（不带 `--worktree`）才只动索引；
 * - `checkout` 带路径（`-- <路径>`、`.`、`./…`）或 `-f`、`switch -f` / `--discard-changes` 覆盖本地改动；
 * - `clean` 删未跟踪文件，`-n` / `--dry-run` 只列清单；
 * - `stash drop` / `clear` 扔掉 stash；
 * - `rm` 只删已跟踪且与索引一致的文件（有未提交修改时 Git 自己拒绝），内容能从 Git 取回；只有递归叠加
 *   `-f` 强制删掉未提交修改时才判危险，`--cached` 只动索引。
 */
function gitSubcommandDanger(subcommand: string, args: readonly string[]): Nullable<string> {
  switch (subcommand) {
    case 'rm': {
      if (hasGitOption(args, null, '--cached')) return null
      const flags = readRemoveFlags(args)
      return flags.recursive && flags.force ? RecursiveRemoveReason : null
    }
    case 'reset':
      return hasGitOption(args, null, '--hard') || hasGitOption(args, null, '--merge') ? GitDiscardReason : null
    case 'restore':
      return hasGitOption(args, 'S', '--staged') && !hasGitOption(args, 'W', '--worktree') ? null : GitDiscardReason
    case 'checkout': {
      const separator = args.indexOf('--')
      const namesPath = (separator >= 0 && separator < args.length - 1)
        || args.some((argument) => argument === '.' || argument.startsWith('./'))
      return namesPath || hasGitOption(args, 'f', '--force') ? GitDiscardReason : null
    }
    case 'switch':
      return hasGitOption(args, 'f', '--force') || hasGitOption(args, null, '--discard-changes') ? GitDiscardReason : null
    case 'clean':
      return hasGitOption(args, 'n', '--dry-run') ? null : GitCleanReason
    case 'stash': {
      const action = args.find((argument) => !argument.startsWith('-'))
      return action === 'drop' || action === 'clear' ? GitStashDropReason : null
    }
    default:
      return null
  }
}

/**
 * 一次调用的危险理由；不危险为 null。
 *
 * - 递归删除（`rm -r` / `-R` / `--recursive` / `rm -Recurse`，不论是否带 `-f`；PowerShell
 *   `Remove-Item`/`ri`/`del`/`rd` 的 `-Recurse`；cmd.exe `rd`/`rmdir`/`del` 的 `/s`）整棵删掉目录，
 *   既不进回收站也不在项目事务里，恢复不了。非递归的 `rm file` 只删单个文件，不拦。
 * - cmd.exe `del /q`：见 `QuietBulkDeleteReason`；`find … -delete` 在整棵目录树里批量删除。
 * - Git 调用按子命令判定，见 `gitSubcommandDanger`。
 * - `find … -exec`、`sh -c`、`eval` 等把另一条命令当参数执行的，递归判定被执行的那条。
 */
function invocationDanger(invocation: ShellInvocation): Nullable<string> {
  const { name, args } = invocation
  if (name === 'rm') return readRemoveFlags(args).recursive ? RecursiveRemoveReason : null
  if (name === 'remove-item' || name === 'ri') return hasPowerShellRecurse(args) ? RecursiveRemoveReason : null
  if (CmdRemoveCommands.has(name)) {
    const switches = readCmdSwitches(args)
    if (switches.has('s') || hasPowerShellRecurse(args)) return RecursiveRemoveReason
    return (name === 'del' || name === 'erase') && switches.has('q') ? QuietBulkDeleteReason : null
  }
  if (name === 'git') {
    const subcommandIndex = findGitSubcommandIndex(args)
    return subcommandIndex < 0 ? null : gitSubcommandDanger(args[subcommandIndex] ?? '', args.slice(subcommandIndex + 1))
  }
  if (name === 'find') {
    if (args.includes('-delete')) return TreeDeleteReason
    for (const [index, argument] of args.entries()) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(argument)) continue
      const executed = readInvocation(args.slice(index + 1))
      const reason = executed ? invocationDanger(executed) : null
      if (reason) return reason
    }
    return null
  }
  const script = readInlineScript(invocation)
  return isNull(script) ? null : describeInvocationDanger(script)
}

/** 逐段读出命令位置上的调用并判定；第一个危险调用的理由就是整条命令的理由。 */
function describeInvocationDanger(command: string): Nullable<string> {
  for (const segment of command.split(CommandSegmentSeparator)) {
    const invocation = readInvocation(tokenize(segment.trim()))
    const reason = invocation ? invocationDanger(invocation) : null
    if (reason) return reason
  }
  return null
}

/** 命令的危险理由；不危险为 null。删除类调用按词法逐条判定，其余破坏性与提权命令沿用通用文案。 */
function describeDangerousCommand(command: string): Nullable<string> {
  const invocationReason = describeInvocationDanger(command)
  if (invocationReason) return invocationReason
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
