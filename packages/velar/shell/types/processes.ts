/**
 * 进程与端口解析结果：ps、lsof、netstat、tasklist 等平台命令输出解析出来的行，以及字节统计。只在包内用，不出包。
 */

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
