import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { KernelModPackRecord } from './mod-store'
import { type KernelModStore,registerSystemModPacks } from './mod-store'

const KernelRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DefaultPacksDirectory = join(KernelRoot, 'packs')

export interface SystemPackDescriptor {
  readonly id: string
  readonly version: string
  readonly entryFile: string
  readonly provides: readonly string[]
  /** When true, skip registration if the entry (or its sibling import) is missing. */
  readonly optional?: boolean
}

/**
 * Built-in system packs shipped next to the Kernel process.
 *
 * agent/model/browser start as transitional stubs so equal consumers see a
 * catalog; workspace/computer/system-tools cold-start when sibling dists exist.
 */
export const DefaultSystemPackDescriptors: readonly SystemPackDescriptor[] = [
  {
    id: 'system.agent',
    version: '0.3.2',
    entryFile: 'agent.entry.mjs',
    provides: ['velaros.agent'],
  },
  {
    id: 'system.model',
    version: '0.3.0',
    entryFile: 'model.entry.mjs',
    provides: ['velaros.model'],
  },
  {
    id: 'system.workspace',
    version: '1.0.0',
    entryFile: 'workspace.entry.mjs',
    provides: ['velaros.workspace'],
  },
  {
    id: 'system.browser',
    version: '0.3.0',
    entryFile: 'browser.entry.mjs',
    provides: ['velaros.browser'],
  },
  {
    id: 'system.computer',
    version: '1.0.0',
    entryFile: 'computer.entry.mjs',
    provides: ['velaros.computer'],
    optional: true,
  },
  {
    id: 'system.system-tools',
    version: '1.0.0',
    entryFile: 'system-tools.entry.mjs',
    provides: ['velaros.system.tools'],
    optional: true,
  },
]

export function resolveKernelPacksDirectory(
  override = process.env.VELAROS_KERNEL_PACKS_DIR?.trim(),
): string {
  if (override !== undefined && override.length > 0) return resolve(override)
  return DefaultPacksDirectory
}

export async function buildDefaultSystemPackRecords(
  packsDirectory = resolveKernelPacksDirectory(),
): Promise<readonly KernelModPackRecord[]> {
  const records: KernelModPackRecord[] = []
  for (const descriptor of DefaultSystemPackDescriptors) {
    const specifier = join(packsDirectory, descriptor.entryFile)
    try {
      await access(specifier)
    } catch {
      if (descriptor.optional === true) continue
      throw new Error(`Required system pack entry missing: ${specifier}`)
    }
    records.push({
      id: descriptor.id,
      kind: 'system',
      version: descriptor.version,
      specifier,
      enabled: true,
      provides: [...descriptor.provides],
    })
  }
  return records
}

/**
 * Register default system packs into the store when AUTO_SYSTEM_PACKS is enabled
 * (default: enabled unless VELAROS_KERNEL_AUTO_SYSTEM_PACKS=0).
 *
 * Registration deliberately omits `enabled`: the built-in default is "on", but a
 * pack the user disabled through `mods.setEnabled` (persisted in the mod index,
 * loaded into the store before this runs) must stay off across restarts.
 * Returns the records as actually registered.
 */
export async function maybeRegisterDefaultSystemPacks(
  store: KernelModStore,
): Promise<readonly KernelModPackRecord[]> {
  const flag = process.env.VELAROS_KERNEL_AUTO_SYSTEM_PACKS?.trim()
  if (flag === '0' || flag === 'false') return []
  const records = await buildDefaultSystemPackRecords()
  registerSystemModPacks(
    store,
    records.map((record) => ({
      id: record.id,
      version: record.version,
      specifier: record.specifier,
      provides: record.provides,
      ...(record.exportName === undefined
        ? {}
        : { exportName: record.exportName }),
    })),
  )
  return records.map((record) => store.get(record.id) ?? record)
}
