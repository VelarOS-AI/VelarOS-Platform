import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  isArray,
  isFalse,
  isFunction,
  isNotUndefined,
  isNull,
  isObject,
  isString,
  isUndefined,
  Log,
  optionalWhen,
  stringifyPretty,
  toOptional,
} from '@velaros-ai/core'
import type { KernelModuleDefinition } from '@velaros-ai/kernel/contracts/abi'
import {
  parseVelarosModEnvelope,
  VelarosModManifestFileName,
} from '@velaros-ai/kernel/contracts/protocol'

import {
  BundledSpecifierScheme,
  type KernelModPackKind,
  type KernelModPackLoadFailure,
  type KernelModPackRecord,
  type KernelModStore,
  type KernelModStorePaths,
} from './mod-store'

const log = Log.tag('KernelModLoader')

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
        log.error('Mod pack load failed', { failure })
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
  if (isNotUndefined(pack.module)) return pack.module
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
  if (!isObject(value) && !isNull(value) || isNull(value)) return false
  const manifest = Reflect.get(value, 'manifest')
  const activate = Reflect.get(value, 'activate')
  return isObject(manifest)
    && isFunction(activate)
}

/**
 * Install a user/contrib pack directory into the store index.
 *
 * Reads `<packDir>/velaros.mod.json` and **only its `module` section** — the
 * Kernel owns that section; `agent` / `ui` belong to the Agent trunk and the
 * product shell and are not even looked at here. That read-permission split is
 * the mechanical defence against the loader growing back into a god object.
 *
 * `module`: `{ "id", "version", "apiVersion", "provides": (string | {id})[],
 *   "entry"?: "./entry.js", "exportName"?: "default", … }`
 *
 * Install-time state (kind / enabled) is the installer's call, not the mod's:
 * a pack cannot declare itself contrib or pre-disabled.
 */
export async function installModPackFromDirectory(
  store: KernelModStore,
  packDirectory: string,
  kind: KernelModPackKind = 'user',
): Promise<KernelModPackRecord> {
  const absolute = isAbsolute(packDirectory)
    ? packDirectory
    : resolve(process.cwd(), packDirectory)
  const manifestPath = join(absolute, VelarosModManifestFileName)
  const raw = await readFile(manifestPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Invalid ${VelarosModManifestFileName} at ${manifestPath}`, {
      cause: error,
    })
  }
  const envelope = parseVelarosModEnvelope(parsed, { origin: manifestPath })
  if (!envelope.ok) {
    throw new Error(
      envelope.diagnostics
        .map((diagnostic) => `${diagnostic.path ?? '<root>'}: ${diagnostic.message}`)
        .join('; '),
    )
  }
  const moduleSection = envelope.envelope.module
  const relativeSpecifier = moduleSection.entry ?? './index.js'
  const pack: KernelModPackRecord = {
    id: moduleSection.id,
    kind,
    version: moduleSection.version,
    specifier: resolve(absolute, relativeSpecifier),
    exportName: toOptional(moduleSection.exportName),
    enabled: true,
    provides: moduleSection.provides.map((token) => token.id),
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
  if (isUndefined(paths.indexPath)) return
  try {
    const raw = await readFile(paths.indexPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isObject(parsed) && !isNull(parsed) || isNull(parsed)) return
    const packs = Reflect.get(parsed, 'packs')
    if (!isArray(packs)) return
    for (const entry of packs) {
      if (!isObject(entry) && !isNull(entry) || isNull(entry)) continue
      const id = Reflect.get(entry, 'id')
      const kind = Reflect.get(entry, 'kind')
      const version = Reflect.get(entry, 'version')
      const specifier = Reflect.get(entry, 'specifier')
      const provides = Reflect.get(entry, 'provides')
      const enabled = Reflect.get(entry, 'enabled')
      const exportName = Reflect.get(entry, 'exportName')
      if (
        !isString(id)
        || !isString(version)
        || !isString(specifier)
        || !isArray(provides)
      ) continue
      if (kind !== 'system' && kind !== 'user' && kind !== 'contrib') continue
      store.register({
        id,
        kind,
        version,
        specifier,
        enabled: !isFalse(enabled),
        provides: provides.filter((item): item is string => isString(item)),
        exportName: optionalWhen(isString, exportName),
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
  if (isUndefined(indexPath)) return
  await mkdir(resolve(indexPath, '..'), { recursive: true })
  const packs = store.list().map(({ module: _module, ...record }) => record)
  await writeFile(
    indexPath,
    `${stringifyPretty({ packs })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

function isNodeError(error: unknown, code: string): boolean {
  return isObject(error)
    && Reflect.get(error, 'code') === code
}
