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
      const subcommand = tokens.slice(executableIndex + 1).find((token) => !token.startsWith('-'))
      return !!subcommand && !mutatingGitCommands.has(subcommand.toLowerCase())
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
