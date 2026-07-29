import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { MemoryStorageErrorCodesV2 } from './ErrorCodes'

/**
 * 五物理根布局（WS3-S1，规范 §7.1 冻结）。
 *
 * ```text
 * <dataRoot>/memory/
 *   authority/   权威库宿主（authority.sqlite3 由 S2 建 schema，本层只管目录与自检）
 *   blobs/       密文正文（两级 hex 分片，BlobStore 管辖）
 *   keyring/     密钥环（代际文件 + CURRENT，永不复制、永不入备份）
 *   index/       派生索引代际（generation-<n>/ + CURRENT，可整体丢弃重建）
 *   backup/      应用管理备份（快照目录只含 authority/ + blobs/ 副本）
 * ```
 *
 * 数据根路径由调用方注入（本包 host 无关，不探测 userData）。"备份只含权威表与
 * 密文"由物理布局保证而非复制排除清单——自检据此把"备份快照内出现 keyring/index"
 * 判为不变量破坏（硬错误），而不是警告。
 */

export interface MemoryPhysicalRootsV2 {
  readonly dataRoot: string
  readonly memoryRoot: string
  readonly authorityDir: string
  /** 权威库文件路径（S2 建库；本层自检只要求"存在则必须是文件"）。 */
  readonly authorityDatabasePath: string
  readonly blobsDir: string
  readonly keyringDir: string
  readonly indexDir: string
  readonly backupDir: string
}

export interface MemoryPhysicalRootsOpenReportV2 {
  /** 本次 open 新建的目录（绝对路径，按创建顺序）。 */
  readonly createdDirectories: readonly string[]
  /** 非致命布局异常（备份快照命名不合规、快照含未知条目等）。 */
  readonly warnings: readonly string[]
}

/** 备份快照目录名：UTC ISO8601 basic（如 `20260725T031500Z`）。 */
export const BackupSnapshotNamePatternV2 = /^\d{8}T\d{6}Z$/

const BackupSnapshotAllowedEntries = new Set(['authority', 'blobs'])
const BackupForbiddenEntries = new Set(['keyring', 'index'])

export function formatBackupSnapshotNameV2(at: number | Date = Date.now()): string {
  const iso = new Date(at).toISOString()
  return `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`
}

/** index 根内代际目录路径（`index/generation-<n>/`）。 */
export function indexGenerationDirV2(indexDir: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new AppError('VALIDATION', 'index 代号必须是正整数。', undefined, { generation })
  }
  return join(indexDir, `generation-${generation}`)
}

/** 纯路径解析（不触盘）。dataRoot 必须为绝对路径——相对路径随 cwd 漂移是布局毒药。 */
export function resolveMemoryPhysicalRootsV2(dataRoot: string): MemoryPhysicalRootsV2 {
  if (!isAbsolute(dataRoot)) {
    throw new AppError('VALIDATION', '记忆存储数据根必须是绝对路径。', undefined, { dataRoot })
  }
  const memoryRoot = join(dataRoot, 'memory')
  const authorityDir = join(memoryRoot, 'authority')
  return {
    dataRoot,
    memoryRoot,
    authorityDir,
    authorityDatabasePath: join(authorityDir, 'authority.sqlite3'),
    blobsDir: join(memoryRoot, 'blobs'),
    keyringDir: join(memoryRoot, 'keyring'),
    indexDir: join(memoryRoot, 'index'),
    backupDir: join(memoryRoot, 'backup'),
  }
}

/**
 * 打开五物理根：按需建目录 + 完整性自检。
 * 硬错误（抛 MEMORY_STORAGE_CORRUPTION / INVARIANT）：根位置被非目录占据、
 * 权威库路径被目录占据、备份快照内出现 keyring/index。
 * 软异常进 report.warnings。
 */
export function openMemoryPhysicalRootsV2(dataRoot: string): {
  roots: MemoryPhysicalRootsV2
  report: MemoryPhysicalRootsOpenReportV2
} {
  const roots = resolveMemoryPhysicalRootsV2(dataRoot)
  const createdDirectories: string[] = []
  const warnings: string[] = []
  const requiredDirs = [
    roots.memoryRoot,
    roots.authorityDir,
    roots.blobsDir,
    roots.keyringDir,
    roots.indexDir,
    roots.backupDir,
  ]
  for (const dir of requiredDirs) {
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) {
        throw new AppError(
          MemoryStorageErrorCodesV2.corruption,
          '物理根位置被非目录条目占据。',
          undefined,
          { path: dir }
        )
      }
      continue
    }
    mkdirSync(dir, { recursive: true })
    createdDirectories.push(dir)
  }
  if (existsSync(roots.authorityDatabasePath) && !statSync(roots.authorityDatabasePath).isFile()) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      '权威库路径被非文件条目占据。',
      undefined,
      { path: roots.authorityDatabasePath }
    )
  }
  auditBackupRoot(roots.backupDir, warnings)
  return { roots, report: { createdDirectories, warnings } }
}

function auditBackupRoot(backupDir: string, warnings: string[]): void {
  for (const snapshot of readdirSync(backupDir, { withFileTypes: true })) {
    if (!snapshot.isDirectory()) {
      warnings.push(`backup 根内存在非快照条目：${snapshot.name}`)
      continue
    }
    if (!BackupSnapshotNamePatternV2.test(snapshot.name)) {
      warnings.push(`backup 快照目录命名不合规（应为 UTC ISO8601 basic）：${snapshot.name}`)
    }
    const snapshotDir = join(backupDir, snapshot.name)
    for (const entry of readdirSync(snapshotDir)) {
      if (BackupForbiddenEntries.has(entry)) {
        throw new AppError(
          'INVARIANT',
          'backup 快照内出现 keyring/index 条目——备份物理边界被破坏（keyring 永不入备份）。',
          undefined,
          { snapshot: snapshot.name, entry }
        )
      }
      if (!BackupSnapshotAllowedEntries.has(entry)) {
        warnings.push(`backup 快照 ${snapshot.name} 含未知条目：${entry}`)
      }
    }
  }
}
