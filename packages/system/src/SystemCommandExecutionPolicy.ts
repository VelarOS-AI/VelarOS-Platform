import { isEmpty, isString, isTrue } from '@velaros-ai/core'

/**
 * shell 命令的**执行前分类**：只读？要确认？该丢后台？
 *
 * 导览（§5.3b ④安全门）——这三个判定各自兜着一道闸，误判的代价互不相同，所以判据也不同：
 * - `isReadOnly` 决定**能否并行执行**（`isParallelCommandExecutionSafe`）。判成"只读"却其实会写，
 *   意味着多个写操作被并发放行。因此这里是 **白名单 + 整体否决**：命令名必须在
 *   `readOnlyCommands` 里，出现任何重定向/反引号/子 shell/后台符（`><`、`` ` ``、`$()`、`&`）
 *   或换行就**整条判非只读**——不做逐段拆解，因为 shell 的组合语法足够刁钻，
 *   "解析对了大部分"在安全判定里等于错。`git` 单独再查一次子命令白名单（`git push` 不是只读）。
 * - `isDangerous` 决定**是否强制确认**。这里是黑名单（`rm -rf`、`mkfs`、`dd if=`、`shutdown`、
 *   `sudo`…），漏判的后果是少弹一次确认框，不是自动放行——真正的授权门在宿主的 ApprovalPort。
 * - `shouldStartInBackground` 是**体验判定**不是安全判定（识别 dev server 之类长驻进程），
 *   误判只会让命令跑在前台或后台，别把它和上面两条混为一谈。
 *
 * 新增命令时的方向：往 `readOnlyCommands` 里加要能证明**任何参数组合下都不写**；
 * 往危险黑名单里加则可以宽松（多弹一次确认无害）。
 */
export interface SystemCommandExecutionPlan {
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
  // （见下方 isSystemShellCommandReadOnly），按小写登记即可；PowerShell 命令名本就
  // 不区分大小写。ls/cat/pwd 等 POSIX 名同时也是 PowerShell 内置别名，重合是有意的。
  'dir', 'type', 'findstr', 'where', 'gci', 'get-childitem', 'get-content', 'gc',
  'get-item', 'gi', 'select-string', 'sls', 'test-path',
])
const mutatingGitCommands = new Set([
  'add', 'am', 'apply', 'bisect', 'branch', 'checkout', 'cherry-pick', 'clean', 'clone',
  'commit', 'fetch', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert',
  'rm', 'stash', 'switch', 'tag',
])

/**
 * 白名单命令里仍然能改盘的参数形态。
 *
 * `find` / `sed` 进 `readOnlyCommands` 的理由是「通常只读」，但 `find … -delete`、
 * `find … -exec rm {} \;`、`sed -i` 都写盘。判成只读的代价是两条：并发放行写操作，
 * 以及无人值守白名单直接执行——所以这里逐条否决具体参数，不做通用参数解析
 * （shell 的参数形态足够刁钻，"解析对了大部分"在安全判定里等于错）。
 */
const mutatingArgumentsByCommand: Readonly<Record<string, readonly RegExp[]>> = {
  find: [/^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/iu],
  // `-i` / `-i.bak` / `-ni` / `--in-place[=SUFFIX]` 都是就地改写。
  sed: [/^-[^-]*i/u, /^--in-place(?:=.*)?$/u],
}

/**
 * Windows（cmd.exe / PowerShell）下与上面两条 POSIX 黑名单对应的破坏性命令形态。
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

function extractPorts(command: string): number[] {
  const ports = new Set<number>()
  for (const match of command.matchAll(/(?:--port(?:=|\s+)|(?:^|\s)-p\s+|:)(\d{2,5})\b/g)) {
    const port = Number(match[1])
    if (port > 0 && port <= 65_535) ports.add(port)
  }
  return [...ports]
}

export function isSystemShellCommandReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[\r\n><`$()]|(^|[^&])&([^&]|$)/.test(trimmed)) return false
  return trimmed.split(/&&|\|\||;|\|/).every((segment) => {
    const tokens = tokenize(segment.trim())
    const executableIndex = tokens.findIndex((token) => !/^[A-Za-z_]\w*=/.test(token))
    if (executableIndex < 0) return false
    const executable = tokens[executableIndex]?.split('/').at(-1)?.toLowerCase()
    if (!executable || !readOnlyCommands.has(executable)) return false
    const args = tokens.slice(executableIndex + 1)
    if (executable === 'git') {
      const subcommand = args.find((token) => !token.startsWith('-'))
      return !!subcommand && !mutatingGitCommands.has(subcommand.toLowerCase())
    }
    const vetoes = mutatingArgumentsByCommand[executable]
    return !(vetoes && args.some((arg) => vetoes.some((pattern) => pattern.test(arg))))
  })
}

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
  const dangerousReason =
    /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bkill\s+-9\s+-1\b/i.test(trimmed)
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
    isReadOnly: isSystemShellCommandReadOnly(trimmed),
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
  return plan.isReadOnly && !plan.shouldRequestConfirmation && !plan.shouldStartInBackground
}

export function shouldReapForegroundProcessGroupAfterExit(command: string): boolean {
  return /(^|[^&])&(?!&)\s*(?:$|[;|\r\n])/.test(command)
    && !/\b(?:nohup|setsid|disown)\b/i.test(command)
}

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
