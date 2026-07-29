import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { type StorageStepHooksV2, writeFileAtomicV2 } from './AtomicFile'
import { MemoryStorageErrorCodesV2 } from './ErrorCodes'

/**
 * CURRENT 生效代指针协议（WS3-S1，规范 §7.1 冻结）。
 *
 * keyring 与 index 两个代际根**共用同一协议**（"一个协议两处用,不发明第二种
 * 原子性"）：CURRENT 文件内容为十进制生效代号；换代 = 写新代实体 → fsync →
 * 原子改写 CURRENT → 删旧代。任一步崩溃后，生效代恒可由 CURRENT 判定：
 * - 代号 > CURRENT 的实体 = 未提交的半成品代际（可判别、可清理）；
 * - 代号 < 保留窗口下界的实体 = 待清理旧代；
 * - CURRENT 缺失/非法的裁决权在各根的 owner（keyring 有内容密钥保护判据）。
 */

export const CurrentPointerFileNameV2 = 'CURRENT'

const GenerationEntryPrefix = 'generation-'

/** 读 CURRENT 指针；文件缺失返回 null，内容非"十进制正整数"一律判损坏。 */
export function readCurrentGenerationV2(directoryPath: string): Nullable<number> {
  const pointerPath = join(directoryPath, CurrentPointerFileNameV2)
  if (!existsSync(pointerPath)) return null
  const raw = readFileSync(pointerPath, 'utf8').trim()
  const generation = Number(raw)
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'CURRENT 指针内容不是合法的十进制代号。',
      undefined,
      { directoryPath }
    )
  }
  return generation
}

/** 原子提交 CURRENT 指针（temp + rename + 目录 fsync）。 */
export function commitCurrentGenerationV2(
  directoryPath: string,
  generation: number,
  options: { label?: string; hooks?: StorageStepHooksV2 } = {}
): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new AppError('VALIDATION', '生效代号必须是正整数。', undefined, { generation })
  }
  writeFileAtomicV2(join(directoryPath, CurrentPointerFileNameV2), String(generation), {
    label: options.label ?? 'current',
    hooks: options.hooks,
  })
}

export interface GenerationEntryV2 {
  readonly generation: number
  readonly name: string
  readonly path: string
}

/**
 * 枚举目录内的代际实体（`generation-<n>` + 指定后缀，文件或目录形态）。
 * 命名不合规的条目一律忽略（不是本协议的实体），返回按代号升序。
 */
export function listGenerationEntriesV2(
  directoryPath: string,
  options: { suffix: string; kind: 'file' | 'directory' }
): GenerationEntryV2[] {
  if (!existsSync(directoryPath)) return []
  const entries: GenerationEntryV2[] = []
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (options.kind === 'file' ? !entry.isFile() : !entry.isDirectory()) continue
    if (!entry.name.startsWith(GenerationEntryPrefix) || !entry.name.endsWith(options.suffix)) continue
    const digits = entry.name.slice(GenerationEntryPrefix.length, entry.name.length - options.suffix.length)
    if (!/^[0-9]+$/.test(digits)) continue
    const generation = Number(digits)
    if (!Number.isSafeInteger(generation) || generation < 1) continue
    entries.push({ generation, name: entry.name, path: join(directoryPath, entry.name) })
  }
  return entries.sort((left, right) => left.generation - right.generation)
}
