/**
 * 进程与端口数据：ps、lsof、netstat、tasklist 等平台命令输出的解析结果，以及字节统计。
 * 只放数据；解析函数在 `utils/system-info.ts`。
 */

// ── 进程与端口：平台命令输出的解析结果 ──────────────────────────

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
