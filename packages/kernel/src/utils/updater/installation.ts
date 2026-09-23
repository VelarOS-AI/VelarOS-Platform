import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { isNotUndefined, isUndefined, Log } from '@velaros-ai/core'

import type {
  KernelInstalledVersion,
  KernelInstallLayout,
  KernelInstallRecord,
} from '../../types/updater'
import { ignoreMissing, readJsonFile, writeJsonFileAtomic } from '../fs'

import { kernelVersionDirectory } from './layout'
import {
  KernelArtifactFormatSchema,
  KernelArtifactTargetSchema,
  KernelVersionSchema,
} from './manifest'
import { compareKernelVersions, isKernelVersion } from './version'

export type { KernelInstalledVersion, KernelInstallRecord } from '../../types/updater'
const log = Log.tag('KernelInstallation')

/**
 * 安装记录的文件名。
 *
 * 它写在暂存目录里、随目录一起改名就位，所以它在场就等于「改名完成、这份安装是整的」。
 */
export const KernelInstallRecordFileName = '.kernel-install.json'

export const KernelInstallRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: KernelVersionSchema,
  target: KernelArtifactTargetSchema,
  format: KernelArtifactFormatSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  installedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<KernelInstallRecord>

/** 读一个安装目录里的安装记录；文件不在、读不动或内容不合格一律当没有（安装不整）。 */
export async function readKernelInstallRecord(
  directory: string
): Promise<KernelInstallRecord | undefined> {
  let input: unknown
  try {
    input = await readJsonFile(join(directory, KernelInstallRecordFileName))
  } catch (error) {
    log.warn('Ignoring unreadable Kernel install record', { directory, error })
    return undefined
  }
  if (isUndefined(input)) return undefined
  const result = KernelInstallRecordSchema.safeParse(input)
  return result.success ? result.data : undefined
}

/** 把安装记录写进暂存目录（先校验再原子落位）；这一步做完这份安装才算整的。 */
export async function writeKernelInstallRecord(
  directory: string,
  record: KernelInstallRecord
): Promise<void> {
  await writeJsonFileAtomic(
    join(directory, KernelInstallRecordFileName),
    KernelInstallRecordSchema.parse(record),
    0o644
  )
}

/** 列出本机装了哪些版本，按版本升序；暂存残留与外来目录直接跳过，版本目录不存在时给空表。 */
export async function listKernelInstalledVersions(
  layout: KernelInstallLayout,
  activeVersion?: string
): Promise<readonly KernelInstalledVersion[]> {
  let entries: string[]
  try {
    entries = (await readdir(layout.versionsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isKernelVersion(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    ignoreMissing(error)
    log.debug('Kernel versions directory does not exist', {
      error,
      path: layout.versionsDirectory,
    })
    return []
  }

  const installed: KernelInstalledVersion[] = []
  for (const version of entries.sort(compareKernelVersions)) {
    const path = kernelVersionDirectory(layout, version)
    const record = await readKernelInstallRecord(path)
    installed.push({
      version,
      path,
      active: version === activeVersion,
      complete: isNotUndefined(record),
      record,
    })
  }
  return installed
}
