import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { isNotUndefined, isUndefined, Log } from '@velaros-ai/core'

import {
  ignoreMissing,
  readJsonFile,
  writeJsonFileAtomic,
} from './fs-utils'
import {
  type KernelInstallLayout,
  kernelVersionDirectory,
} from './layout'
import {
  KernelArtifactFormatSchema,
  KernelArtifactTargetSchema,
  KernelVersionSchema,
} from './manifest'
import {
  compareKernelVersions,
  isKernelVersion,
} from './version'

const log = Log.tag('KernelInstallation')

/**
 * Written inside the staging directory before it is renamed into place, so its
 * presence is proof that the rename completed and the install is whole.
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
})
export type KernelInstallRecord = z.infer<typeof KernelInstallRecordSchema>

export interface KernelInstalledVersion {
  readonly version: string
  readonly path: string
  readonly active: boolean
  readonly complete: boolean
  readonly record?: KernelInstallRecord
}

export async function readKernelInstallRecord(
  directory: string,
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

export async function writeKernelInstallRecord(
  directory: string,
  record: KernelInstallRecord,
): Promise<void> {
  await writeJsonFileAtomic(
    join(directory, KernelInstallRecordFileName),
    KernelInstallRecordSchema.parse(record),
    0o644,
  )
}

/** Ascending by version. Staging leftovers and foreign directories are ignored. */
export async function listKernelInstalledVersions(
  layout: KernelInstallLayout,
  activeVersion?: string,
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
