import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 存储物理层的原子文件底座（WS3-S1）。
 *
 * 规范依据：[docs/memory-tree-spec-freeze.md](../../../../../../docs/memory-tree-spec-freeze.md) §7.1
 * ——"写新代 → fsync → 原子改写 → 删旧代"的换代协议在 keyring 与 index 两根共用，
 * 本文件是该协议的唯一写入原语：temp（同目录、独占创建）→ fsync(temp) → rename →
 * fsync(承载目录)。最后一步是批 A 点名的证明义务③：POSIX rename 只有在对父目录
 * fsync 之后才有崩溃持久性承诺（rename 本身只保证可见性原子，不保证落盘顺序）。
 *
 * 崩溃注入：所有写入步骤在执行前经 `StorageStepHooksV2.beforeStep` 汇报，
 * 探针（storage-v2-probe.ts）在指定步骤抛错即模拟"该步骤之前断电"——同步 IO
 * 使"抛错点 = 崩溃点"严格成立，恢复逻辑（keyring open / blob cleanupResidue）
 * 必须能从任一步骤的残局收敛。真实崩溃残留 = `*.tmp` 文件 + 未提交的目标文件，
 * 两者都可由 `removeStaleTempFilesV2` 与各自 owner 的恢复协议判别清理。
 */

/** 崩溃注入钩子：beforeStep 在每个写入步骤前调用；探针在指定 step 抛错模拟断电。 */
export interface StorageStepHooksV2 {
  beforeStep?(step: string): void
}

export function invokeStorageStepV2(hooks: StorageStepHooksV2 | undefined, step: string): void {
  hooks?.beforeStep?.(step)
}

/** 临时文件统一后缀：崩溃残留可被机械识别与清理。 */
export const StorageTempFileSuffixV2 = '.tmp'

/**
 * 对承载目录 fsync（证明义务③）。win32 不支持目录 fd fsync（NTFS 元数据日志自持），
 * 该平台跳过；POSIX 平台任何失败原样上抛——静默吞错等于放弃持久性承诺。
 */
export function fsyncDirectoryV2(directoryPath: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(directoryPath, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 原子写文件：同目录独占 temp → 写入 → fsync(temp) → rename → fsync(目录)。
 * 步骤名 = `${label}:write-temp | fsync-temp | rename | fsync-dir`，供崩溃注入定位。
 * 中途失败不清理 temp（真实崩溃也不会清理），残留由 owner 的恢复协议统一处置。
 */
export function writeFileAtomicV2(
  filePath: string,
  data: string | Buffer,
  options: { label: string; hooks?: StorageStepHooksV2 }
): void {
  const directory = dirname(filePath)
  const tempPath = join(
    directory,
    `${basename(filePath)}.${randomBytes(4).toString('hex')}${StorageTempFileSuffixV2}`
  )
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  invokeStorageStepV2(options.hooks, `${options.label}:write-temp`)
  const fd = openSync(tempPath, 'wx')
  try {
    writeFileSync(fd, payload)
    invokeStorageStepV2(options.hooks, `${options.label}:fsync-temp`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  invokeStorageStepV2(options.hooks, `${options.label}:rename`)
  renameSync(tempPath, filePath)
  invokeStorageStepV2(options.hooks, `${options.label}:fsync-dir`)
  fsyncDirectoryV2(directory)
}

/** 清理目录内的崩溃残留 temp 文件（不递归），返回清理数量。目录不存在视同无残留。 */
export function removeStaleTempFilesV2(directoryPath: string): number {
  if (!existsSync(directoryPath)) return 0
  let removed = 0
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(StorageTempFileSuffixV2)) continue
    rmSync(join(directoryPath, entry.name), { force: true })
    removed += 1
  }
  if (removed > 0) fsyncDirectoryV2(directoryPath)
  return removed
}
