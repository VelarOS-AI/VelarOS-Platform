import { basename } from 'node:path'

import { isNotNull, isNull } from '@velaros-ai/core'

export interface ParsedProcessRow {
  pid: number
  ppid: number
  user: string
  startTime: string
  status: string
  cpuPercent: number
  memoryBytes: number
  name: string
  command: string
}

export interface RawPortEntry {
  pid: Nullable<number>
  processName: Nullable<string>
  address: string
  port: number
  state: Nullable<string>
}

export interface ByteStats {
  usedBytes: number
  totalBytes: number
}

export function parseProcessRows(stdout: string, platform: NodeJS.Platform): ParsedProcessRow[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => parseProcessLine(line, platform))
    .filter((row): row is ParsedProcessRow => isNotNull(row))
}

export function parseOpenPortEntries(stdout: string, platform: NodeJS.Platform): RawPortEntry[] {
  return platform === 'win32'
    ? parseWindowsOpenPortEntries(stdout)
    : parseLsofOpenPortEntries(stdout)
}

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

function parseWindowsTasklistFields(line: string): Nullable<string[]> {
  if (!line.startsWith('"')) return null
  const fields: string[] = []
  const pattern = /"((?:[^"]|"")*)"(?:,|$)/gu
  let match: Nullable<RegExpExecArray>
  while ((match = pattern.exec(line))) fields.push((match[1] ?? '').replace(/""/gu, '"'))
  return fields.length === 5 ? fields : null
}

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

function positiveInteger(value: string): Nullable<number> {
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseTabSeparatedByteStats(stdout: string): Nullable<ByteStats> {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  const [usedText, totalText] = line?.split('\t') ?? []
  const usedBytes = Number(usedText)
  const totalBytes = Number(totalText)
  return Number.isFinite(usedBytes) && Number.isFinite(totalBytes) && totalBytes > 0
    ? { usedBytes, totalBytes }
    : null
}

function readMeminfoKilobytes(stdout: string, key: string): number {
  const match = stdout.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm'))
  return match ? Number(match[1]) : Number.NaN
}

function convertSizedValueToBytes(value: number, unit: string): number {
  const multiplier = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }[unit] ?? 1
  return Math.round(value * multiplier)
}

function normalizePercent(value: number): Nullable<number> {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value * 100) / 100)) : null
}
