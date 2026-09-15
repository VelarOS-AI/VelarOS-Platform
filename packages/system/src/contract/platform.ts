/**
 * 平台数据：兼容层的选项与命令规格、平台命令输出的解析结果、共享资源目录的解析选项。
 * 只放数据；兼容层与共享资源目录的接口在 `interface/provides.ts`。
 */

import type { SystemShellKind } from './system.js'

// ── 跨平台兼容层的选项与命令规格 ────────────────────────────────

export type RuntimePlatform = NodeJS.Platform

export interface SystemPlatformCompatibilityOptions {
  env?: NodeJS.ProcessEnv
  platform?: RuntimePlatform
}

export interface ShellCommandSpecOptions extends SystemPlatformCompatibilityOptions {
  shellPath?: string
  kind?: SystemShellKind
}

export interface DefaultAppDataPathOptions extends SystemPlatformCompatibilityOptions {
  homeDir?: string
}

export interface CommandSpec {
  file: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

export interface EditorCommandDefinition {
  darwinApplication?: string
  command?: string
}

export interface BackgroundShellLaunchOptions {
  command: string
  logPath: string
  pidMarker: string
  shellPath: string
}

export type PathTextSeparator = '/' | '\\'

export type DirectorySymlinkType = 'dir' | 'junction'

// ── VelarOS 共享资源根目录 ──────────────────────────────

export interface VelarOSSharedResourceStoreOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

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
