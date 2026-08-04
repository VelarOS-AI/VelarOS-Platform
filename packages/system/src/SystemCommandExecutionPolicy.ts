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
])
const mutatingGitCommands = new Set([
  'add', 'am', 'apply', 'bisect', 'branch', 'checkout', 'cherry-pick', 'clean', 'clone',
  'commit', 'fetch', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert',
  'rm', 'stash', 'switch', 'tag',
])

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
    if (executable === 'git') {
      const subcommand = tokens.slice(executableIndex + 1).find((token) => !token.startsWith('-'))
      return !!subcommand && !mutatingGitCommands.has(subcommand.toLowerCase())
    }
    return true
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
      ? '该命令可能删除数据、破坏文件系统或终止关键进程。'
      : /\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b/i.test(trimmed)
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
