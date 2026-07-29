import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { KernelModuleDefinition } from '@velaros-ai/core/kernel/abi'

export interface KernelModuleManifestEntry {
  /** Absolute path or path relative to the manifest file. */
  readonly specifier: string
  /** Named export that resolves to a KernelModuleDefinition. Defaults to `default`. */
  readonly exportName?: string
}

export interface KernelModuleManifest {
  readonly modules: readonly KernelModuleManifestEntry[]
}

/**
 * Loads Kernel module definitions from a JSON manifest of dynamic import paths.
 *
 * The Kernel process never statically depends on concrete capability packages —
 * composition roots list importable module entry points in this file (or env).
 */
export async function loadKernelModulesFromManifest(
  manifestPath: string,
): Promise<readonly KernelModuleDefinition[]> {
  const absoluteManifest = isAbsolute(manifestPath)
    ? manifestPath
    : resolve(process.cwd(), manifestPath)
  const raw = await readFile(absoluteManifest, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `Kernel module manifest is not valid JSON: ${absoluteManifest}`,
      { cause: error },
    )
  }
  const manifest = parseManifest(parsed, absoluteManifest)
  const baseDirectory = resolve(absoluteManifest, '..')
  const modules: KernelModuleDefinition[] = []
  for (const entry of manifest.modules) {
    modules.push(await loadModuleEntry(entry, baseDirectory))
  }
  return modules
}

function parseManifest(
  input: unknown,
  path: string,
): KernelModuleManifest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`Kernel module manifest root must be an object: ${path}`)
  }
  const modulesInput = Reflect.get(input, 'modules')
  if (!Array.isArray(modulesInput)) {
    throw new Error(
      `Kernel module manifest must declare a "modules" array: ${path}`,
    )
  }
  const modules: KernelModuleManifestEntry[] = []
  for (const [index, entry] of modulesInput.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        `Kernel module manifest entry ${index} must be an object: ${path}`,
      )
    }
    const specifier = Reflect.get(entry, 'specifier')
    if (typeof specifier !== 'string' || specifier.trim().length === 0) {
      throw new Error(
        `Kernel module manifest entry ${index} requires a non-empty "specifier": ${path}`,
      )
    }
    const exportName = Reflect.get(entry, 'exportName')
    if (
      exportName !== undefined
      && (typeof exportName !== 'string' || exportName.trim().length === 0)
    ) {
      throw new Error(
        `Kernel module manifest entry ${index} "exportName" must be a non-empty string: ${path}`,
      )
    }
    modules.push({
      specifier: specifier.trim(),
      ...(typeof exportName === 'string'
        ? { exportName: exportName.trim() }
        : {}),
    })
  }
  return { modules }
}

async function loadModuleEntry(
  entry: KernelModuleManifestEntry,
  baseDirectory: string,
): Promise<KernelModuleDefinition> {
  const resolved = isAbsolute(entry.specifier)
    ? entry.specifier
    : resolve(baseDirectory, entry.specifier)
  const importUrl = pathToFileURL(resolved).href
  const exported = await import(importUrl) as Record<string, unknown>
  const exportName = entry.exportName ?? 'default'
  const value = exported[exportName]
  if (!isKernelModuleDefinition(value)) {
    throw new Error(
      `Kernel module export "${exportName}" from "${resolved}" is not a KernelModuleDefinition`,
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
