import { z } from 'zod'

import { isUndefined } from '@velaros-ai/core'

import type { KernelActivePointer } from '../../types/updater'
import { KernelUpdaterError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from '../fs'

import { KernelVersionSchema } from './manifest'

export type { KernelActivePointer } from '../../types/updater'
/**
 * `current.json`。`previousVersion` 是回滚目标，只要它还记在这里，那个版本就不会被清掉。
 */
export const KernelActivePointerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: KernelVersionSchema,
  previousVersion: KernelVersionSchema.nullable(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string().min(1).nullable(),
}) satisfies z.ZodType<KernelActivePointer>

/** 指针备份文件名的前缀，和 `current.json` 同宗。 */
const PointerBackupPrefix = 'current.'

/** 指针备份文件名的后缀。 */
const PointerBackupSuffix = '.json'

/** 校验一份激活指针；结构不合格时抛 INVALID_POINTER。 */
export function parseKernelActivePointer(input: unknown): KernelActivePointer {
  const result = KernelActivePointerSchema.safeParse(input)
  if (!result.success) {
    throw new KernelUpdaterError(
      'INVALID_POINTER',
      '内核的激活版本指针不合法',
      {},
      { cause: result.error }
    )
  }
  return result.data
}

/** 读出激活指针；文件不在时是 undefined，读不动或内容不合格时抛 INVALID_POINTER。 */
export async function readKernelActivePointer(
  pointerPath: string
): Promise<KernelActivePointer | undefined> {
  let input: unknown
  try {
    input = await readJsonFile(pointerPath)
  } catch (error) {
    throw new KernelUpdaterError(
      'INVALID_POINTER',
      '读不出内核的激活版本指针',
      { path: pointerPath },
      { cause: error }
    )
  }
  if (isUndefined(input)) return undefined
  return parseKernelActivePointer(input)
}

/** 整份写下激活指针（先校验再原子改名落位），从不部分更新。 */
export async function writeKernelActivePointer(
  pointerPath: string,
  pointer: KernelActivePointer
): Promise<void> {
  await writeJsonFileAtomic(pointerPath, parseKernelActivePointer(pointer))
}

/** 一份指针备份该叫什么：`current.<版本>.<写入时刻>.json`。 */
export function kernelPointerBackupFileName(pointer: KernelActivePointer): string {
  return `${PointerBackupPrefix}${pointer.version}.${pointer.updatedAt}${PointerBackupSuffix}`
}

/** 判断备份目录里的一个文件名是不是指针备份。 */
export function isKernelPointerBackupFileName(name: string): boolean {
  return name.startsWith(PointerBackupPrefix) && name.endsWith(PointerBackupSuffix)
}

/**
 * 从备份文件名里取回写入时刻。
 *
 * 版本号自己带点，所以按最后一段取；取不出就当 0（排在最旧，优先被清掉）。
 */
export function kernelPointerBackupTimestamp(name: string): number {
  const segments = name.slice(0, -PointerBackupSuffix.length).split('.')
  const updatedAt = Number(segments.at(-1))
  return Number.isFinite(updatedAt) ? updatedAt : 0
}
