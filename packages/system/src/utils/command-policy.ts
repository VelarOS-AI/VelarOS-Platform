/**
 * 命令分类：执行前判断一条 shell 命令是否只读、是否危险、是否该转入后台。
 */
import { isEmpty, isNull, isString, isTrue, toNullable } from '@velaros-ai/core'

import type { ShellInvocation, SystemCommandExecutionPlan } from '../types/commands.js'


const readOnlyCommands = new Set([
  'cat', 'cut', 'date', 'df', 'du', 'env', 'find', 'git', 'grep', 'head', 'id', 'ls',
  'pwd', 'rg', 'sed', 'stat', 'tail', 'tree', 'uname', 'wc', 'which', 'whoami',
  // Windows（cmd.exe / PowerShell）只读读法。可执行名在查表前已统一 toLowerCase()
  // （见下方 isSystemShellCommandReadOnly），按小写登记即可；PowerShell 命令名本就
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
 * 白名单命令里仍然能改盘或执行别的程序的参数形态。
 *
 * `find` / `rg` / `tree` 进 `readOnlyCommands` 的理由是「通常只读」，但 `find … -delete`、`find … -exec rm {} \;`、
 * `rg --pre rm`、`tree -o file` 都会写盘或执行别的程序。判成只读的代价是两条：并发放行写操作，以及无人值守白名单直接执行——
 * 所以这里逐条否决具体参数，不做通用参数解析（shell 的参数形态足够刁钻，"解析对了大部分"在安全判定里等于错）。
 * sed 的脚本本身就能写盘和执行命令，单独按 isReadOnlySedInvocation 整段解析。
 */
const mutatingArgumentsByCommand: Readonly<Record<string, readonly RegExp[]>> = {
  find: [/^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/iu],
  // `rg --pre cmd` 对每个文件执行 cmd，`--hostname-bin cmd` 执行 cmd 取主机名。
  rg: [/^--pre(?:=.*)?$/u, /^--hostname-bin(?:=.*)?$/u],
  // `tree -o file` / `--output` 把目录树写进文件，短选项可以连写（`-ao file`）；`-R` 在每层目录里再生成一份 00Tree.html。
  tree: [/^-[^-]*[oR]/u, /^--output(?:=.*)?$/u],
}

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

const GitForcePushReason = '该命令会强制覆盖远端分支的历史，别人已经拉取或推送的提交会被丢弃。'

const GitForceBranchDeleteReason = '该命令会强制删除分支，分支上没合并的提交会丢失。'

/** `git worktree remove --force`：连同工作树里未提交的改动一起删。 */
const GitForceWorktreeRemoveReason = '该命令会强制删除工作树目录，其中未提交的改动会永久丢失。'

/** `git update-ref -d`：直接删引用，指向的提交可能再也找不回来。 */
const GitRefDeleteReason = '该命令会直接删除 Git 引用，它指向的提交可能再也找不回来。'

/** `git reflog expire --expire=now`：立刻清掉 reflog，丢失的提交没法再靠它找回。 */
const GitReflogExpireReason = '该命令会立即清空 reflog，之后丢失的提交将无法通过 reflog 找回。'

/** `git filter-branch -f`：强制改写整个分支历史。 */
const GitHistoryRewriteReason = '该命令会强制改写整个分支历史，原来的提交会被替换。'

const RemoteScriptReason = '该命令把网上下载的脚本不经检查直接交给 shell 执行。'

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

/** 把网上下载的内容直接管道给 shell：curl/wget 接 sh、bash、zsh，或 PowerShell 的 iwr/irm 接 iex。 */
const remoteScriptPatterns: readonly RegExp[] = [
  /\b(?:curl|wget)\b[^|&;\r\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k|fi)?sh\b/i,
  /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|&;\r\n]*\|\s*(?:iex|invoke-expression)\b/i,
]

/** 藏在脚本或别的程序里的递归删除：Python 的 shutil.rmtree、Node 的 rimraf、CMD 的 rd/rmdir/del /s。整个文件夹连同里面的仓库一起没掉，和 rm -rf 一样危险。 */
const scriptedRecursiveRemovePatterns: readonly RegExp[] = [
  /\brmtree\s*\(/i,
  /\brimraf\b/i,
  /\brm(?:Sync)?\s*\((?=[^)]*\brecursive\s*:\s*true)/i,
  /\b(?:rd|rmdir)\b[^&|;\r\n]*\s\/s(?=\s|$)/i,
  /\bdel\b[^&|;\r\n]*\s\/s(?=\s|$)/i,
]

const windowsPrivilegedMutationPatterns: readonly RegExp[] = [
  /\brunas\b|\bstart-process\b[^&|;\r\n]*\s-verb(?:\s+|:)['"]?runas\b/i,
  /\btakeown\b|\bicacls\b[^&|;\r\n]*\/reset\b/i,
  // `icacls ... /grant` 单独出现很常见且通常无害（给单个文件加一条权限）；只有再叠加
  // 递归 `/t` 才逼近"对根目录批量改权限"，因此用双 lookahead 要求二者同现、不论先后。
  /\bicacls\b(?=[^&|;\r\n]*\/grant\b)(?=[^&|;\r\n]*\/t\b)/i,
]

/** 把命令文本按空白切成词，引号里的空格不切，并去掉外层引号。 */
function tokenize(command: string): string[] {
  return command.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g)?.map((token) =>
    token.replace(/^(['"])(.*)\1$/, '$2').replace(/(['"])(.*?)\1/g, '$2')
  ) ?? []
}

/** 判断一个 git 全局选项是否把取值直接写在自己身上，如 `-Crepo`、`--git-dir=path`。 */
function hasInlineGitGlobalOptionValue(token: string): boolean {
  if (token.startsWith('-C') && token.length > 2) return true
  if (token.startsWith('-c') && token.length > 2 && token.includes('=')) return true
  return gitGlobalOptionsWithInlineValue.some((prefix) =>
    token.startsWith(prefix) && token.length > prefix.length
  )
}

/** 在 git 实参里跳过全局选项，返回子命令的位置；遇到认不出的选项返回 -1。 */
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

/** 判断一个 git 全局选项能不能让 git 去执行别的程序：`-c key=value`、`--config-env`、`--exec-path`、`-p` / `--paginate` 都能（pager、diff.external、fsmonitor 这类配置就是命令）。 */
function isExecutableGitGlobalOption(argument: string): boolean {
  return argument === '-c' || (argument.startsWith('-c') && argument.includes('='))
    || argument === '--config-env' || argument.startsWith('--config-env=')
    || argument === '--exec-path' || argument.startsWith('--exec-path=')
    || argument === '-p' || argument === '--paginate'
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

/** 取命令词的规范名：去掉路径前缀与 `.exe` 后缀，统一小写。 */
function commandName(token: string): string {
  return (token.split(/[/\\]/).at(-1) ?? token).toLowerCase().replace(/\.exe$/, '')
}

/** 跳过前缀命令（如 sudo、env、timeout）自己的选项与取值，返回真正被执行的命令词位置。 */
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

/** 读出一段命令里真正执行的那次调用：跳过环境变量赋值、shell 保留字与前缀命令。 */
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
    const next = skipPrefixArguments(name, tokens, index + 1)
    // 前缀命令后面没有别的命令词（`env`、`env -u FOO`），这次调用就是前缀命令本身。
    if (next >= tokens.length) return { name, args: tokens.slice(index + 1) }
    index = next
  }
  return null
}

/** 按 GNU 的唯一前缀规则判断实参是不是某个长选项，如 `--rec` 即 `--recursive`。 */
function matchesLongOption(argument: string, option: string): boolean {
  return argument.length >= 3 && option.startsWith(argument)
}

/** 判断实参能否表示某个 PowerShell 参数：大小写不敏感，可按唯一前缀缩写。 */
function matchesPowerShellParameter(argument: string, parameter: string, minimumLength: number): boolean {
  const [name = '', value] = argument.toLowerCase().split(':', 2)
  return value !== '$false' && name.length >= minimumLength && parameter.startsWith(name)
}

/** 判断实参里有没有 PowerShell 的 `-Recurse`，含缩写与 `:$true` 写法。 */
function hasPowerShellRecurse(args: readonly string[]): boolean {
  return args.some((argument) => matchesPowerShellParameter(argument, '-recurse', 2))
}

/** 读出 `rm` 是否递归、是否强制：POSIX 选项簇、GNU 长选项、PowerShell 参数名三种写法都认。 */
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

/** 读出实参里的 cmd.exe 开关字母（小写），`/s /q` 与 `/s/q` 都拆成 s 与 q。 */
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

/** 取出解释器以参数形式执行的那段命令文本，如 `bash -c`、`eval`、`powershell -Command`；没有返回 null。 */
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

/** 判断某个 git 选项是否在 `--` 之前出现，长选项与合写的短选项簇都认，区分大小写。 */
function hasGitOption(args: readonly string[], short: Nullable<string>, long: string): boolean {
  const options = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  return options.some((argument) =>
    argument === long
    || argument.startsWith(`${long}=`)
    || (isString(short) && /^-[A-Za-z]+$/.test(argument) && argument.includes(short)))
}

/** 判断一个 git 子命令会不会丢掉无法恢复的改动，返回危险理由；不危险返回 null。 */
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
    case 'push':
      return hasGitOption(args, 'f', '--force') || hasGitOption(args, null, '--force-with-lease') || hasGitOption(args, null, '--force-if-includes') ? GitForcePushReason : null
    case 'branch':
      return args.some((argument) => /^-[A-Za-z]*D[A-Za-z]*$/.test(argument)) || (hasGitOption(args, 'd', '--delete') && hasGitOption(args, 'f', '--force')) ? GitForceBranchDeleteReason : null
    case 'worktree':
      return args[0] === 'remove' && hasGitOption(args, 'f', '--force') ? GitForceWorktreeRemoveReason : null
    case 'update-ref':
      return hasGitOption(args, 'd', '--delete') ? GitRefDeleteReason : null
    case 'reflog':
      return args[0] === 'expire' && args.some((argument) => /^--expire(?:-unreachable)?=(?:now|all)$/.test(argument)) ? GitReflogExpireReason : null
    case 'filter-branch':
      return hasGitOption(args, 'f', '--force') ? GitHistoryRewriteReason : null
    default:
      return null
  }
}

/** 判断一次调用的危险理由；不危险返回 null。 */
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
    // -c key=value 的值可能就是要执行的程序（core.pager、diff.external、core.fsmonitor…），把值当命令再查一遍。
    for (const [index, argument] of args.entries()) {
      if (subcommandIndex >= 0 && index >= subcommandIndex) break
      const assignment = argument === '-c' ? args[index + 1] : argument.startsWith('-c') && argument.includes('=') ? argument.slice(2) : null
      const configured = assignment?.slice(assignment.indexOf('=') + 1) ?? ''
      const reason = /\s/.test(configured) ? describeInvocationDanger(configured) : null
      if (reason) return reason
    }
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

/** 逐段检查命令里的每次调用，返回第一个危险调用的理由；都不危险返回 null。 */
function describeInvocationDanger(command: string): Nullable<string> {
  for (const segment of command.split(CommandSegmentSeparator)) {
    const invocation = readInvocation(tokenize(segment.trim()))
    const reason = invocation ? invocationDanger(invocation) : null
    if (reason) return reason
  }
  return null
}

/** 本身就是长驻服务的程序名。 */
const LongRunningCommands = new Set(['vite', 'webpack-dev-server', 'webpack-serve', 'nodemon', 'serve', 'http-server', 'live-server', 'browser-sync', 'json-server', 'ngrok', 'caddy', 'nginx', 'redis-server', 'mongod', 'postgres', 'mysqld'])

/** 包管理器与脚本运行器：后面跟 dev / serve / start / watch（或 run 再跟这几个）才算长驻。 */
const ScriptRunners = new Set(['npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx', 'deno', 'cargo', 'make'])

/** 常见框架 CLI：后面跟 dev / serve / start 才算长驻。 */
const FrameworkCommands = new Set(['next', 'nuxt', 'astro', 'remix', 'gatsby', 'expo', 'ng', 'vue-cli-service', 'react-scripts', 'rails', 'flask', 'uvicorn', 'gunicorn', 'php'])

const ServiceSubcommands = new Set(['dev', 'serve', 'server', 'start', 'watch', 'preview', 's'])

/** 一条命令是不是会长期驻留：只看命令名和子命令的位置，不在整条文本里找 dev、start 这种词（`cat dev`、`ls start` 不算）；末尾裸 `&` 也算。 */
function looksLikeLongRunningService(command: string): boolean {
  if (/(^|[^&])&\s*$/.test(command)) return true
  return command.split(CommandSegmentSeparator).some((segment) => {
    const invocation = readInvocation(tokenize(segment.trim()))
    if (!invocation) return false
    const name = invocation.name.toLowerCase()
    const words = invocation.args.filter((argument) => !argument.startsWith('-')).map((argument) => argument.toLowerCase())
    if (LongRunningCommands.has(name)) return true
    if (name === 'python' || name === 'python3') return invocation.args[0] === '-m' && invocation.args[1] === 'http.server'
    if (ScriptRunners.has(name)) return ServiceSubcommands.has(words[0] ?? '') || (words[0] === 'run' && ServiceSubcommands.has(words[1] ?? ''))
    if (FrameworkCommands.has(name)) return ServiceSubcommands.has(words[0] ?? '') || (name === 'php' && invocation.args.includes('-S'))
    return false
  })
}

/** 给出整条命令的危险理由：删除类按词法判定，其余破坏性与提权命令按通用规则判定；不危险返回 null。 */
function describeDangerousCommand(command: string): Nullable<string> {
  const invocationReason = describeInvocationDanger(command)
  if (invocationReason) return invocationReason
  if (remoteScriptPatterns.some((pattern) => pattern.test(command))) return RemoteScriptReason
  if (scriptedRecursiveRemovePatterns.some((pattern) => pattern.test(command))) return RecursiveRemoveReason
  if (
    /\bmkfs\b|\bdd\b[^&|;\r\n]*\b(?:if|of)=|\bdiskutil\s+(?:erase(?:disk|volume)|reformat|partitiondisk|secureerase|zerodisk|randomdisk)\b|\bshutdown\b|\breboot\b|\bkill\s+-9\s+-1\b/i.test(command)
    || windowsDestructivePatterns.some((pattern) => pattern.test(command))
  ) return DestructiveCommandReason
  if (
    /\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b/i.test(command)
    || windowsPrivilegedMutationPatterns.some((pattern) => pattern.test(command))
  ) return PrivilegedMutationReason
  return null
}

/** 从命令文本里找出可能占用的端口号，如 `--port 3000`、`-p 8080`、`:5173`。 */
function extractPorts(command: string): number[] {
  const ports = new Set<number>()
  for (const match of command.matchAll(/(?:--port(?:=|\s+)|(?:^|\s)-p\s+|:)(\d{2,5})\b/g)) {
    const port = Number(match[1])
    if (port > 0 && port <= 65_535) ports.add(port)
  }
  return [...ports]
}

/** 前缀命令里能自己写盘或执行别的程序的选项：env 的 -S / --split-string 把一段文本拆开当命令执行，time 的 -o / --output 把计时写进文件。 */
const mutatingPrefixOptions: Readonly<Record<string, readonly RegExp[]>> = {
  env: [/^-[^-]*S/u, /^--split-string(?:=.*)?$/u],
  time: [/^-[^-]*o/u, /^--output(?:=.*)?$/u],
}

/**
 * 只读判定专用：命令位置上有没有能改掉白名单命令行为的前缀写法。环境变量赋值（`LD_PRELOAD=…`、`GIT_EXTERNAL_DIFF=…`、
 * `RIPGREP_CONFIG_PATH=…`，也包括 `env NAME=value`）能让白名单命令去执行别的程序，前缀命令的 env -S、time -o 也一样，出现就不算只读。
 */
function hasMutatingPrefix(tokens: readonly string[]): boolean {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (/^[A-Za-z_]\w*=/.test(token)) return true
    if (ShellReservedWords.has(token)) {
      index += 1
      continue
    }
    const name = commandName(token)
    if (!CommandPrefixes.has(name)) return false
    const next = skipPrefixArguments(name, tokens, index + 1)
    const vetoes = mutatingPrefixOptions[name] ?? []
    if (tokens.slice(index + 1, next).some((argument) => vetoes.some((pattern) => pattern.test(argument)))) return true
    index = next
  }
  return false
}

/** sed 只读时允许的短选项簇：-n 不自动打印、-E / -r 扩展正则、-s 各文件分开、-u 不缓冲、-z 按 NUL 分行；-i 就地改写、-f 从文件读脚本等都不在内。 */
const SedReadOnlyOptionCluster = /^-[nErsuz]+$/

/** sed 只读时允许的长选项。 */
const SedReadOnlyLongOptions = new Set(['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--posix', '--debug', '--sandbox'])

/** sed 脚本里不写盘、不执行命令的单字母指令；l、q、Q 后面可以跟一个数字。 */
const SedReadOnlyCommands = new Set(['=', 'p', 'P', 'd', 'D', 'n', 'N', 'g', 'G', 'h', 'H', 'x', 'z', 'l', 'q', 'Q'])

/** 能当 sed 分隔符、而且各家 sed 切法都一样的字符：不是空白、反斜杠、方括号、字母和数字。 */
function isSedDelimiter(char: string): boolean {
  return char.length === 1 && !/[\s\\[\]A-Za-z0-9]/u.test(char)
}

/**
 * 一段 sed 脚本是否只由不写盘、不执行命令的指令组成：地址（行号、first~step、$、/正则/、\c正则c，区间、+N、~N 与 !）后面只许
 * = p P d D n N g G h H x z l q Q、{ }、s///（标志只许 g p i I m M 与数字）、y///；w、W、r、R、e、a、i、c、b、t、: 等一律不认。
 * 正则里的方括号表达式不许含分隔符、[ 与反斜杠：各家 sed 对这种写法切得不一样，认不准就按会写处理。
 */
function isReadOnlySedScript(script: string): boolean {
  let index = 0
  let depth = 0
  const peek = (): string => script[index] ?? ''
  const isDigit = (): boolean => /^[0-9]$/u.test(peek())
  const skipDigits = (): void => {
    while (isDigit()) index += 1
  }
  const skipBlanks = (): void => {
    while (peek() === ' ' || peek() === '\t') index += 1
  }
  // 读到分隔符为止（index 停在分隔符之后）；正则里的方括号表达式整段跳过，里面出现分隔符、[ 或反斜杠就认不准。
  const readDelimited = (delimiter: string, isRegex: boolean): boolean => {
    while (index < script.length) {
      const char = peek()
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === delimiter) {
        index += 1
        return true
      }
      if (isRegex && char === '[') {
        index += 1
        if (peek() === '^') index += 1
        if (peek() === ']') index += 1
        while (index < script.length && peek() !== ']') {
          if (peek() === delimiter || peek() === '[' || peek() === '\\') return false
          index += 1
        }
        if (peek() !== ']') return false
      }
      index += 1
    }
    return false
  }
  // 读一个地址；没有地址时不动 index。
  const readAddress = (): boolean => {
    if (isDigit()) {
      skipDigits()
      if (peek() !== '~') return true
      index += 1
      if (!isDigit()) return false
      skipDigits()
      return true
    }
    if (peek() === '$') {
      index += 1
      return true
    }
    if (peek() !== '/' && peek() !== '\\') return true
    if (peek() === '\\') index += 1
    const delimiter = peek()
    if (!isSedDelimiter(delimiter)) return false
    index += 1
    if (!readDelimited(delimiter, true)) return false
    while (peek() === 'I' || peek() === 'M') index += 1
    return true
  }
  while (true) {
    while (peek() === ' ' || peek() === '\t' || peek() === ';') index += 1
    if (index >= script.length) return depth === 0
    const start = index
    if (!readAddress()) return false
    const hasAddress = index > start
    skipBlanks()
    if (hasAddress && peek() === ',') {
      index += 1
      skipBlanks()
      if (peek() === '+' || peek() === '~') {
        index += 1
        if (!isDigit()) return false
        skipDigits()
      } else {
        const second = index
        if (!readAddress() || index === second) return false
      }
      skipBlanks()
    }
    if (hasAddress && peek() === '!') {
      index += 1
      skipBlanks()
    }
    const command = peek()
    index += 1
    if (command === '{') {
      depth += 1
      continue
    }
    if (command === '}') {
      if (hasAddress || depth === 0) return false
      depth -= 1
    } else if (command === 's' || command === 'y') {
      const delimiter = peek()
      if (!isSedDelimiter(delimiter)) return false
      index += 1
      if (!readDelimited(delimiter, command === 's') || !readDelimited(delimiter, false)) return false
      if (command === 's') {
        while (/^[gpiImM0-9]$/u.test(peek())) index += 1
      }
    } else if (SedReadOnlyCommands.has(command)) {
      if (command === 'l' || command === 'q' || command === 'Q') {
        skipBlanks()
        skipDigits()
      }
    } else {
      return false
    }
    skipBlanks()
    if (!isEmpty(peek()) && peek() !== ';' && peek() !== '}') return false
  }
}

/**
 * 判断 sed 这一次调用在任何输入下都不写盘、不执行命令：选项只许上面几个（-i 就地改写、-f 从文件读脚本都算会写），
 * 每段脚本（-e、--expression 给的，或者没有它们时的第一个操作数）都要过 isReadOnlySedScript；认不出的一律按会写处理。
 */
function isReadOnlySedInvocation(args: readonly string[]): boolean {
  const scripts: string[] = []
  const operands: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (argument === '--') {
      operands.push(...args.slice(index + 1))
      break
    }
    if (argument === '-' || !argument.startsWith('-')) {
      operands.push(argument)
      continue
    }
    // --expression 与短选项簇里的 e：取值连写在后面（--expression=p、-e'p'、-ne'p'），没连写就取下一个词。
    const expression = /^--expression(?:=(.*))?$/su.exec(argument) ?? /^-[nErsuz]*e(.*)$/su.exec(argument)
    if (expression) {
      let script = expression[1]
      if (!script) {
        index += 1
        script = args[index]
      }
      if (!isString(script)) return false
      scripts.push(script)
      continue
    }
    if (!SedReadOnlyOptionCluster.test(argument) && !SedReadOnlyLongOptions.has(argument)) return false
  }
  if (isEmpty(scripts)) {
    const script = operands[0]
    if (!isString(script)) return false
    scripts.push(script)
  }
  return scripts.every((script) => isReadOnlySedScript(script))
}

/**
 * 判断只读 git 子命令的实参里有没有会写文件或执行别的程序的选项：任何子命令的 --output；grep 的 -O / --open-files-in-pager
 * （拿匹配到的文件去开 pager，pager 就是一条命令）；ls-remote 的 -u / --upload-pack / --exec（在本机执行给定的程序）。长选项按 git 的唯一前缀缩写认。
 */
function hasMutatingGitArguments(subcommand: string, args: readonly string[]): boolean {
  const abbreviates = (argument: string, option: string, minimumLength: number): boolean => {
    const name = argument.split('=', 1)[0] ?? ''
    return name.length >= minimumLength && option.startsWith(name)
  }
  return args.some((argument) => {
    if (argument === '--output' || argument.startsWith('--output=')) return true
    if (subcommand === 'grep') return /^-[^-]*O/u.test(argument) || abbreviates(argument, '--open-files-in-pager', 4)
    if (subcommand === 'ls-remote') return /^-[^-]*u/u.test(argument) || abbreviates(argument, '--upload-pack', 3) || abbreviates(argument, '--exec', 5)
    return false
  })
}

/** 判断一条 shell 命令在任何参数组合下都不会写盘：白名单命令加整体否决，拿不准一律判为非只读。 */
export function isSystemShellCommandReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[\r\n><`$()]|(^|[^&])&([^&]|$)/.test(trimmed)) return false
  return trimmed.split(/&&|\|\||;|\|/).every((segment) => {
    // env、xargs 这类前缀命令后面才是真正要跑的程序，按它判断；前缀本身在只读白名单里也不能放行。提权的一律不算只读。
    if (/(?:^|\s)(?:sudo|doas|runas)\b/i.test(segment)) return false
    const tokens = tokenize(segment.trim())
    // 环境变量赋值、env -S、time -o 这类前缀写法能改掉白名单命令的行为，出现就不算只读。
    if (hasMutatingPrefix(tokens)) return false
    const invocation = readInvocation(tokens)
    if (!invocation) return false
    const executable = invocation.name.toLowerCase()
    if (!readOnlyCommands.has(executable)) return false
    const args = invocation.args
    if (executable === 'git') {
      const subcommandIndex = findGitSubcommandIndex(args)
      if (subcommandIndex < 0) return false
      // -c key=value、--config-env、--exec-path、-p 能让 log/diff/status 这类只读子命令去执行别的程序（core.pager、diff.external、core.fsmonitor…），一律不算只读。
      if (args.slice(0, subcommandIndex).some((argument) => isExecutableGitGlobalOption(argument))) return false
      const subcommand = args[subcommandIndex]
      return !!subcommand
        && readOnlyGitCommands.has(subcommand)
        && !hasMutatingGitArguments(subcommand, args.slice(subcommandIndex + 1))
    }
    if (executable === 'sed') return isReadOnlySedInvocation(args)
    const vetoes = mutatingArgumentsByCommand[executable]
    return !(vetoes && args.some((arg) => vetoes.some((pattern) => pattern.test(arg))))
  })
}

/** 执行前给命令分类：是否只读、是否危险、是否该转入后台、是否要用户确认，以及可能占用的端口。 */
export function analyzeCommandExecution(command: string): SystemCommandExecutionPlan {
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
  const reason = looksLikeLongRunningService(trimmed)
      ? '该命令看起来会启动长期驻留的服务或监听进程。'
      : null
  return {
    isReadOnly: isSystemShellCommandReadOnly(trimmed),
    shouldRequestConfirmation: !!dangerousReason || !!reason,
    shouldStartInBackground: !!reason,
    reason,
    isDangerous: !!dangerousReason,
    dangerousReason,
    ports: extractPorts(trimmed),
  }
}

/** 判断一次命令调用能否与其他调用并发：必须声明可并发、不转后台、只读且无需确认。 */
export function isParallelCommandExecutionSafe(input: {
  command?: unknown
  background?: unknown
  parallel?: unknown
}): boolean {
  if (!isTrue(input.parallel) || isTrue(input.background) || !isString(input.command)) return false
  const plan = analyzeCommandExecution(input.command)
  return plan.isReadOnly && !plan.shouldRequestConfirmation && !plan.shouldStartInBackground
}


/** 生成危险命令或长驻命令的确认文案，写明命令、理由、是否后台运行与可能占用的端口。 */
export function buildBackgroundCommandConfirmationMessage(
  command: string,
  plan: SystemCommandExecutionPlan,
  scopeLabel: string,
  willRunInBackground: boolean
): string {
  const portSuffix = !isEmpty(plan.ports) ? ` 可能涉及端口：${plan.ports.join(', ')}。` : ''
  if (plan.isDangerous) return [
      `准备在${scopeLabel}执行高风险命令：${command}`,
      plan.dangerousReason ?? '该命令可能造成不可逆结果。',
      ...(plan.dangerousReason === RecursiveRemoveReason || plan.dangerousReason === TreeDeleteReason
        ? ['如果目标是一个项目或仓库目录（含 .git），未推送的提交和未提交的改动会一起没掉，无法找回。']
        : []),
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
