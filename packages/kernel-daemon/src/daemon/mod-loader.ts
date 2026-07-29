import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { KernelModuleDefinition } from '@velaros-ai/core/kernel/abi'

import {
  BundledSpecifierScheme,
  type KernelModPackKind,
  type KernelModPackLoadFailure,
  type KernelModPackRecord,
  type KernelModStore,
  type KernelModStorePaths,
} from './mod-store'
import { loadKernelModulesFromManifest } from './module-manifest'

export interface LoadModsResult {
  readonly modules: readonly KernelModuleDefinition[]
  /** Packs that produced a module (subset of the enabled packs). */
  readonly packs: readonly KernelModPackRecord[]
  /** Enabled packs whose module could not be loaded; never empty silently. */
  readonly failures: readonly KernelModPackLoadFailure[]
}

/**
 * Resolves enabled packs from a ModStore into KernelModuleDefinition instances.
 */
export class KernelModLoader {
  public constructor(private readonly store: KernelModStore) {}

  /**
   * Loads every enabled pack with **per-pack isolation**.
   *
   * An installed pack entry is arbitrary third-party code behind a top-level
   * `await`; letting one bad import bubble out of here took the whole Kernel
   * process down with it. A failure now costs exactly that one capability: it is
   * logged, recorded on the store as a failed pack, and returned in
   * {@link LoadModsResult.failures} — never swallowed.
   *
   * Since P4 the runtime failure surface is **installed packs only**: bundled
   * packs carry their module from the build graph (see `bundled-packs.ts`), so a
   * broken one is a red build, not a degraded boot. The isolation stays as-is —
   * it is the installed channel's contract, not the bundled one's.
   *
   * Clients see the gap as "enabled in mods.list but absent from handshake
   * modules"; the readable reason lives in the Kernel log until the mods wire
   * descriptor grows a status field.
   */
  public async loadEnabled(): Promise<LoadModsResult> {
    const enabled = this.store.listEnabled()
    const modules: KernelModuleDefinition[] = []
    const packs: KernelModPackRecord[] = []
    const failures: KernelModPackLoadFailure[] = []
    for (const pack of enabled) {
      try {
        modules.push(await loadPackModule(pack))
        packs.push(pack)
        this.store.clearLoadFailure(pack.id)
      } catch (error) {
        const failure: KernelModPackLoadFailure = {
          id: pack.id,
          kind: pack.kind,
          specifier: pack.specifier,
          reason: describeLoadFailure(error),
        }
        this.store.markLoadFailure(failure)
        failures.push(failure)
        console.error(
          `[velaros-kernel] mod pack "${pack.id}" (${pack.kind}) failed to load from "${pack.specifier}": ${failure.reason}`,
        )
      }
    }
    return { modules, packs, failures }
  }
}

function describeLoadFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  const causeText = cause instanceof Error ? ` (cause: ${cause.message})` : ''
  return `${error.name}: ${error.message}${causeText}`
}

async function loadPackModule(
  pack: KernelModPackRecord,
): Promise<KernelModuleDefinition> {
  // Bundled pack: the module came in through the build graph, so there is
  // nothing to resolve or import — `specifier` is only its identity.
  if (pack.module !== undefined) return pack.module
  if (pack.specifier.startsWith(BundledSpecifierScheme)) {
    // Orphan: the persisted index still lists a bundled pack that this build no
    // longer compiles in. Its identity URI is not importable — say so, do not
    // let it fall through into a nonsensical file-path import.
    throw new Error(
      `Mod pack "${pack.id}" is a bundled pack that is no longer compiled into this Kernel build ("${pack.specifier}")`,
    )
  }
  const resolved = isAbsolute(pack.specifier)
    ? pack.specifier
    : resolve(process.cwd(), pack.specifier)
  const importUrl = pathToFileURL(resolved).href
  const exported = await import(importUrl) as Record<string, unknown>
  const exportName = pack.exportName ?? 'default'
  const value = exported[exportName]
  if (!isKernelModuleDefinition(value)) {
    throw new Error(
      `Mod pack "${pack.id}" export "${exportName}" from "${resolved}" is not a KernelModuleDefinition`,
    )
  }
  return value
}

function isKernelModuleDefinition(
  value: unknown,
): value is KernelModuleDefinition {
  if (typeof value !== 'object' || value === null) return false
  const manifest = Reflect.get(value, 'manifest')
  const activate = Reflect.get(value, 'activate')
  return typeof manifest === 'object'
    && manifest !== null
    && typeof activate === 'function'
}

/**
 * Install a user/contrib pack directory into the store index.
 *
 * Expects `<packDir>/mod.json`:
 * `{ "id", "version", "kind"?: "user"|"contrib", "specifier"?: "./entry.js",
 *    "exportName"?: "default", "provides": string[], "enabled"?: boolean }`
 */
export async function installModPackFromDirectory(
  store: KernelModStore,
  packDirectory: string,
): Promise<KernelModPackRecord> {
  const absolute = isAbsolute(packDirectory)
    ? packDirectory
    : resolve(process.cwd(), packDirectory)
  const manifestPath = join(absolute, 'mod.json')
  const raw = await readFile(manifestPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Invalid mod.json at ${manifestPath}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`mod.json root must be an object: ${manifestPath}`)
  }
  const id = readRequiredString(parsed, 'id')
  const version = readRequiredString(parsed, 'version')
  const kindValue = Reflect.get(parsed, 'kind')
  const kind: KernelModPackKind =
    kindValue === 'contrib' ? 'contrib' : 'user'
  const specifierValue = Reflect.get(parsed, 'specifier')
  const relativeSpecifier = typeof specifierValue === 'string'
    && specifierValue.trim().length > 0
    ? specifierValue.trim()
    : './index.js'
  const exportNameValue = Reflect.get(parsed, 'exportName')
  const providesInput = Reflect.get(parsed, 'provides')
  if (!Array.isArray(providesInput) || providesInput.some((item) => typeof item !== 'string')) {
    throw new Error(`mod.json "provides" must be a string array: ${manifestPath}`)
  }
  const enabledValue = Reflect.get(parsed, 'enabled')
  const pack: KernelModPackRecord = {
    id,
    kind,
    version,
    specifier: resolve(absolute, relativeSpecifier),
    ...(typeof exportNameValue === 'string' && exportNameValue.trim().length > 0
      ? { exportName: exportNameValue.trim() }
      : {}),
    enabled: enabledValue !== false,
    provides: providesInput as string[],
  }
  await access(pack.specifier)
  store.register(pack)
  await persistModIndex(store)
  return pack
}

export async function loadModIndexIntoStore(
  store: KernelModStore,
  paths: KernelModStorePaths = store.paths,
): Promise<void> {
  if (paths.indexPath === undefined) return
  try {
    const raw = await readFile(paths.indexPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return
    const packs = Reflect.get(parsed, 'packs')
    if (!Array.isArray(packs)) return
    for (const entry of packs) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = Reflect.get(entry, 'id')
      const kind = Reflect.get(entry, 'kind')
      const version = Reflect.get(entry, 'version')
      const specifier = Reflect.get(entry, 'specifier')
      const provides = Reflect.get(entry, 'provides')
      const enabled = Reflect.get(entry, 'enabled')
      const exportName = Reflect.get(entry, 'exportName')
      if (
        typeof id !== 'string'
        || typeof version !== 'string'
        || typeof specifier !== 'string'
        || !Array.isArray(provides)
      ) continue
      if (kind !== 'system' && kind !== 'user' && kind !== 'contrib') continue
      store.register({
        id,
        kind,
        version,
        specifier,
        enabled: enabled !== false,
        provides: provides.filter((item): item is string => typeof item === 'string'),
        ...(typeof exportName === 'string' ? { exportName } : {}),
      })
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

/**
 * Writes the pack index (identity + enabled bit).
 *
 * A bundled pack's `module` is a live object graph, not data — it is dropped
 * here on purpose: the index persists *decisions* (which packs the user turned
 * off), while the payload always comes back from the build graph.
 */
export async function persistModIndex(store: KernelModStore): Promise<void> {
  const indexPath = store.paths.indexPath
  if (indexPath === undefined) return
  await mkdir(resolve(indexPath, '..'), { recursive: true })
  const packs = store.list().map(({ module: _module, ...record }) => record)
  await writeFile(
    indexPath,
    `${JSON.stringify({ packs }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

/**
 * Register system packs from the legacy JSON module manifest shape, then load.
 * Kept so VELAROS_KERNEL_MODULES continues to work during the ModStore transition.
 */
export async function loadModulesCompat(
  modulesManifestPath: string | undefined,
  store: KernelModStore,
): Promise<readonly KernelModuleDefinition[]> {
  if (modulesManifestPath !== undefined && modulesManifestPath.trim().length > 0) return loadKernelModulesFromManifest(modulesManifestPath)
  await loadModIndexIntoStore(store)
  const loader = new KernelModLoader(store)
  const loaded = await loader.loadEnabled()
  return loaded.modules
}

function readRequiredString(input: object, field: string): string {
  const value = Reflect.get(input, field)
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`mod.json field "${field}" must be a non-empty string`)
  }
  return value.trim()
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'code') === code
}
