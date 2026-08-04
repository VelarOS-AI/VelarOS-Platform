import { z } from 'zod'

import { isUndefined } from '@velaros-ai/core'

import { KernelUpdaterError } from './errors'
import {
  readJsonFile,
  writeJsonFileAtomic,
} from './fs-utils'
import { KernelVersionSchema } from './manifest'

/**
 * `current.json`. `previousVersion` is the rollback target and is never pruned
 * while it is recorded here.
 */
export const KernelActivePointerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: KernelVersionSchema,
  previousVersion: KernelVersionSchema.nullable(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string().min(1).nullable(),
})
export type KernelActivePointer = z.infer<typeof KernelActivePointerSchema>

export function parseKernelActivePointer(input: unknown): KernelActivePointer {
  const result = KernelActivePointerSchema.safeParse(input)
  if (!result.success) {
    throw new KernelUpdaterError(
      'INVALID_POINTER',
      'Kernel active version pointer is invalid',
      {},
      { cause: result.error },
    )
  }
  return result.data
}

export async function readKernelActivePointer(
  pointerPath: string,
): Promise<KernelActivePointer | undefined> {
  let input: unknown
  try {
    input = await readJsonFile(pointerPath)
  } catch (error) {
    throw new KernelUpdaterError(
      'INVALID_POINTER',
      'Kernel active version pointer could not be read',
      { path: pointerPath },
      { cause: error },
    )
  }
  if (isUndefined(input)) return undefined
  return parseKernelActivePointer(input)
}

export async function writeKernelActivePointer(
  pointerPath: string,
  pointer: KernelActivePointer,
): Promise<void> {
  await writeJsonFileAtomic(pointerPath, parseKernelActivePointer(pointer))
}
