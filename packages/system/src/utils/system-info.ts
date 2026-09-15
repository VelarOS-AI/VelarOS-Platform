/**
 * 系统信息：解析各平台进程、端口、CPU、磁盘、交换区命令的输出，按查询条件筛选进程与端口，给指标定告警级别。
 */

import { basename } from 'node:path'

import { isNotNull, isNull, isPresent, toNullable } from '@velaros-ai/core'

import type { ByteStats, ParsedProcessRow, RawPortEntry } from '../contract/process-info.js'
import type {
  SystemOpenPortInfo,
  SystemOpenPortQueryOptions,
  SystemProcessInfo,
  SystemProcessQueryOptions,
} from '../contract/system.js'

/** 把进程行转成对外的进程信息，再按查询条件筛选：过滤词、pid、名字、命令行片段、用户、只看当前用户、CPU 与内存下限；最多 limit 条（默认 50）。 */
export function selectSystemProcesses(rows: ParsedProcessRow[], options: SystemProcessQueryOptions): SystemProcessInfo[] {
  const limit = options.limit ?? 50
  const filter = options.filter?.trim().toLowerCase()
  const pids = new Set(options.pids ?? [])
  const currentUser = toNullable(process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME)

  return rows
    .map((row): SystemProcessInfo => ({
      ...row,
      cwd: null,
      startTime: row.startTime || null,
    }))
    .filter((processInfo) => {
      if (filter && !`${processInfo.name}\0${processInfo.command}`.toLowerCase().includes(filter)) return false
      if (options.pid && processInfo.pid !== options.pid) return false
      if (pids.size > 0 && !pids.has(processInfo.pid)) return false
      if (options.name && !processInfo.name.includes(options.name)) return false
      if (options.commandContains && !processInfo.command.includes(options.commandContains)) return false
      if (options.user && processInfo.user !== options.user) return false
      if (options.onlyCurrentUser && !isCurrentUser(processInfo.user, currentUser)) return false
      if (options.minCpuPercent && processInfo.cpuPercent < options.minCpuPercent) return false
      if (options.minMemoryBytes && processInfo.memoryBytes < options.minMemoryBytes) return false
      return true
    })
    .slice(0, limit)
}

/** 取出端口条目里出现的全部 pid，去重。 */
export function collectPortPids(entries: RawPortEntry[]): number[] {
  return [...new Set(entries.map((entry) => entry.pid).filter((pid): pid is number => isPresent(pid)))]
}

/** 给端口条目配上占用进程的名字、命令行和工作目录，再按查询条件筛选：过滤词、pid、进程名、端口、端口范围；最多 limit 条（默认 50）。 */
export function selectOpenPorts(
  entries: RawPortEntry[],
  processInfoByPid: Map<number, SystemProcessInfo>,
  options: SystemOpenPortQueryOptions
): SystemOpenPortInfo[] {
  const limit = options.limit ?? 50
  const filter = options.filter?.trim().toLowerCase()
  const ports = new Set(options.ports ?? [])

  return entries
    .map((entry): SystemOpenPortInfo => {
      const processInfo = entry.pid ? toNullable(processInfoByPid.get(entry.pid)) : null
      return {
        port: entry.port,
        protocol: 'tcp',
        pid: entry.pid,
        processName: processInfo?.name ?? entry.processName,
        command: toNullable(processInfo?.command ?? entry.processName),
        address: entry.address,
        state: entry.state,
        cwd: toNullable(processInfo?.cwd),
      }
    })
    .filter((entry) => {
      if (filter && !`${entry.processName ?? ''}\0${entry.command ?? ''}`.toLowerCase().includes(filter)) return false
      if (options.pid && entry.pid !== options.pid) return false
      if (options.processName && !entry.processName?.includes(options.processName)) return false
      if (options.port && entry.port !== options.port) return false
      if (ports.size > 0 && !ports.has(entry.port)) return false
      if (options.rangeStart && entry.port < options.rangeStart) return false
      if (options.rangeEnd && entry.port > options.rangeEnd) return false
      return true
    })
    .slice(0, limit)
}

/** 按阈值给一个百分比指标定级：到 highThreshold 为 high，到 warnThreshold 为 warn，否则 normal；没有数值时为 unknown。 */
export function metricLevel(
  value: Nullable<number>,
  warnThreshold = 75,
  highThreshold = 90
): 'unknown' | 'normal' | 'warn' | 'high' {
  if (!isPresent(value) || !Number.isFinite(value)) return 'unknown'
  if (value >= highThreshold) return 'high'
  if (value >= warnThreshold) return 'warn'
  return 'normal'
}

/** 判断进程的用户是不是当前用户；Windows 上进程用户带域名前缀（形如 DOMAIN 反斜杠 user）也算。 */
function isCurrentUser(processUser: string, currentUser: Nullable<string>): boolean {
  if (!currentUser) return false
  return processUser === currentUser || processUser.endsWith(`\\${currentUser}`)
}

/** 把各平台进程列表命令的输出解析成进程行，认不出的行跳过。 */
export function parseProcessRows(stdout: string, platform: NodeJS.Platform): ParsedProcessRow[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => parseProcessLine(line, platform))
    .filter((row): row is ParsedProcessRow => isNotNull(row))
}

/** 把各平台监听端口命令的输出解析成端口条目：Windows 用 netstat 或制表符格式，其余平台用 lsof 格式。 */
export function parseOpenPortEntries(stdout: string, platform: NodeJS.Platform): RawPortEntry[] {
  return platform === 'win32'
    ? parseWindowsOpenPortEntries(stdout)
    : parseLsofOpenPortEntries(stdout)
}

/** 从各平台 CPU 采样命令的输出算出 CPU 使用率百分比；解析不了返回 null。 */
export function parseCpuUsagePercent(stdout: string, platform: NodeJS.Platform): Nullable<number> {
  if (platform === 'darwin') {
    const match = stdout.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys/i)
    return match ? normalizePercent(Number(match[1]) + Number(match[2])) : null
  }
  if (platform === 'linux') {
    const cpuLine = stdout.split(/\r?\n/).find((line) => line.startsWith('cpu '))
    const values = cpuLine?.trim().split(/\s+/).slice(1).map(Number)
    if (!values || values.length < 4 || values.some((value) => !Number.isFinite(value))) return null
    const idle = values[3] + (values[4] ?? 0)
    const total = values.reduce((sum, value) => sum + value, 0)
    return total > 0 ? normalizePercent(((total - idle) / total) * 100) : null
  }
  return platform === 'win32' ? normalizePercent(Number(stdout.trim().split(/\r?\n/)[0])) : null
}

/** 从各平台交换区命令的输出读出已用与总量字节数；解析不了返回 null。 */
export function parseSwapStats(stdout: string, platform: NodeJS.Platform): Nullable<ByteStats> {
  if (platform === 'darwin') {
    const totalMatch = stdout.match(/total = ([\d.]+)([KMGTP])/)
    const usedMatch = stdout.match(/used = ([\d.]+)([KMGTP])/)
    return totalMatch && usedMatch ? {
      usedBytes: convertSizedValueToBytes(Number(usedMatch[1]), usedMatch[2]),
      totalBytes: convertSizedValueToBytes(Number(totalMatch[1]), totalMatch[2]),
    } : null
  }
  if (platform === 'linux') {
    const totalKb = readMeminfoKilobytes(stdout, 'SwapTotal')
    const freeKb = readMeminfoKilobytes(stdout, 'SwapFree')
    return Number.isFinite(totalKb) && Number.isFinite(freeKb) && totalKb > 0
      ? { usedBytes: Math.max(totalKb - freeKb, 0) * 1024, totalBytes: totalKb * 1024 }
      : null
  }
  return platform === 'win32' ? parseTabSeparatedByteStats(stdout) : null
}

/** 从各平台磁盘命令的输出读出已用与总量字节数；解析不了返回 null。 */
export function parseDiskStats(stdout: string, platform: NodeJS.Platform): Nullable<ByteStats> {
  if (platform === 'win32') return parseTabSeparatedByteStats(stdout)
  const row = stdout.split(/\r?\n/).map((line) => line.trim()).find((line, index) => index > 0 && line)
  const parts = row?.split(/\s+/)
  if (!parts || parts.length < 5) return null
  const totalBlocks = Number(parts[1])
  const usedBlocks = Number(parts[2])
  return Number.isFinite(totalBlocks) && Number.isFinite(usedBlocks)
    ? { usedBytes: usedBlocks * 1024, totalBytes: totalBlocks * 1024 }
    : null
}

/** 解析进程列表里的一行；认不出返回 null。 */
function parseProcessLine(line: string, platform: NodeJS.Platform): Nullable<ParsedProcessRow> {
  const trimmed = line.trimEnd()
  if (!trimmed) return null
  if (platform === 'win32') {
    const tasklist = parseWindowsTasklistFields(trimmed)
    if (tasklist) {
      const [name, pidText, , , memoryText] = tasklist
      const pid = positiveInteger(pidText ?? '')
      const memoryKb = Number((memoryText ?? '').replace(/\D/gu, ''))
      if (isNull(pid) || !Number.isFinite(memoryKb)) return null
      return {
        pid, ppid: 0, user: '', startTime: '', status: 'Running', cpuPercent: 0,
        memoryBytes: memoryKb * 1024, name: name || String(pid), command: name || String(pid),
      }
    }
    const parts = trimmed.split('\t')
    const pid = positiveInteger(parts[0] ?? '')
    const ppid = positiveInteger(parts[1] ?? '')
    const cpuPercent = Number(parts[5])
    const memoryKb = Number(parts[6])
    if (isNull(pid) || isNull(ppid) || !Number.isFinite(cpuPercent) || !Number.isFinite(memoryKb)) return null
    const name = parts[7]?.trim() || String(pid)
    return {
      pid, ppid, user: parts[2]?.trim() || '', startTime: parts[3]?.trim() || '',
      status: parts[4]?.trim() || 'Running', cpuPercent, memoryBytes: memoryKb * 1024,
      name, command: parts.slice(8).join('\t').trim() || name,
    }
  }
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(trimmed)
  return match ? {
    pid: Number(match[1]), ppid: Number(match[2]), user: match[3], startTime: match[4],
    status: match[5], cpuPercent: Number(match[6]), memoryBytes: Number(match[7]) * 1024,
    name: basename(match[8]), command: match[9],
  } : null
}

/** 解析 lsof 字段格式输出（p、c、n、TST 开头的行）里的监听端口。 */
function parseLsofOpenPortEntries(stdout: string): RawPortEntry[] {
  const entries: RawPortEntry[] = []
  let pid: Nullable<number> = null
  let processName: Nullable<string> = null
  let current: Nullable<RawPortEntry> = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) { pid = positiveInteger(line.slice(1)); processName = null; current = null }
    else if (line.startsWith('c')) processName = line.slice(1).trim() || null
    else if (line.startsWith('n')) {
      const parsed = parseAddressAndPort(line.slice(1))
      if (parsed) {
        current = { pid, processName, address: parsed.address, port: parsed.port, state: null }
        entries.push(current)
      }
    } else if (line.startsWith('TST=') && current) current.state = line.slice(4).trim() || null
  }
  return entries
}

/** 解析 Windows 上的监听端口输出：制表符分隔格式，或 netstat 的 LISTENING 行。 */
function parseWindowsOpenPortEntries(stdout: string): RawPortEntry[] {
  return stdout.split(/\r?\n/).map((line): Nullable<RawPortEntry> => {
    const parts = line.trimEnd().split('\t')
    const port = positiveInteger(parts[3] ?? '')
    if (parts.length >= 5 && isNotNull(port)) return {
      pid: positiveInteger(parts[0] ?? ''),
      processName: parts[1]?.trim() || null,
      address: parts[2]?.trim() || '',
      port,
      state: parts[4]?.trim() || null,
    }

    const netstat = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu.exec(line)
    if (!netstat) return null
    const address = parseAddressAndPort(netstat[1]!)
    return address ? {
      pid: positiveInteger(netstat[2]!),
      processName: null,
      address: address.address,
      port: address.port,
      state: 'LISTENING',
    } : null
  }).filter((entry): entry is RawPortEntry => isNotNull(entry))
}

/** 把 tasklist CSV 的一行拆成五个字段；格式不对返回 null。 */
function parseWindowsTasklistFields(line: string): Nullable<string[]> {
  if (!line.startsWith('"')) return null
  const fields: string[] = []
  const pattern = /"((?:[^"]|"")*)"(?:,|$)/gu
  let match: Nullable<RegExpExecArray>
  while ((match = pattern.exec(line))) fields.push((match[1] ?? '').replace(/""/gu, '"'))
  return fields.length === 5 ? fields : null
}

/** 把「地址:端口」拆成地址与端口，支持 IPv6 的「[地址]:端口」；拆不出返回 null。 */
function parseAddressAndPort(value: string): Nullable<{ address: string; port: number }> {
  const trimmed = value.trim()
  const separator = trimmed.startsWith('[') ? trimmed.lastIndexOf(']:') : trimmed.lastIndexOf(':')
  if (separator < 0) return null
  const port = positiveInteger(trimmed.slice(separator + (trimmed.startsWith('[') ? 2 : 1)))
  if (isNull(port)) return null
  return {
    address: trimmed.startsWith('[') ? trimmed.slice(1, separator) : trimmed.slice(0, separator),
    port,
  }
}

/** 把文本解析成正整数；不是正整数返回 null。 */
function positiveInteger(value: string): Nullable<number> {
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/** 解析「已用<TAB>总量」格式的字节统计；解析不了返回 null。 */
function parseTabSeparatedByteStats(stdout: string): Nullable<ByteStats> {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  const [usedText, totalText] = line?.split('\t') ?? []
  const usedBytes = Number(usedText)
  const totalBytes = Number(totalText)
  return Number.isFinite(usedBytes) && Number.isFinite(totalBytes) && totalBytes > 0
    ? { usedBytes, totalBytes }
    : null
}

/** 从 /proc/meminfo 文本里读出某一项的千字节数；没有该项返回 NaN。 */
function readMeminfoKilobytes(stdout: string, key: string): number {
  const match = stdout.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm'))
  return match ? Number(match[1]) : Number.NaN
}

/** 把带 K、M、G、T、P 单位的数值换算成字节数。 */
function convertSizedValueToBytes(value: number, unit: string): number {
  const multiplier = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }[unit] ?? 1
  return Math.round(value * multiplier)
}

/** 把百分比夹在 0 到 100 之间并保留两位小数；不是有限数返回 null。 */
function normalizePercent(value: number): Nullable<number> {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value * 100) / 100)) : null
}
