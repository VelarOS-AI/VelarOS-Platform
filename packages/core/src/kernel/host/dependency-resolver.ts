import type {
  CapabilityRequirement,
  CapabilityToken,
  KernelModuleDefinition,
  KernelModuleManifest,
} from '../abi'

import { KernelHostError } from './errors'
import { assertSemanticVersion, satisfiesVersionRange } from './version'

export interface KernelModulePlan {
  readonly order: readonly string[]
  readonly capabilityProviders: ReadonlyMap<
    string,
    KernelCapabilityProvider
  >
}

export interface KernelCapabilityProvider {
  readonly moduleId: string
  readonly capability: CapabilityToken
}

function compareIdentifiers(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function assertNonEmpty(value: string, label: string, moduleId?: string): void {
  if (value.trim().length > 0) return

  throw new KernelHostError(
    'INVALID_MANIFEST',
    `${label} must not be empty`,
    { moduleId },
  )
}

function assertUniqueValues(
  values: readonly string[],
  label: string,
  moduleId: string,
): void {
  const seen = new Set<string>()
  for (const value of values) {
    assertNonEmpty(value, label, moduleId)
    if (seen.has(value)) {
      throw new KernelHostError(
        'INVALID_MANIFEST',
        `Module "${moduleId}" declares duplicate ${label} "${value}"`,
        { moduleId, capabilityId: value },
      )
    }
    seen.add(value)
  }
}

function assertRequirements(
  requirements: readonly CapabilityRequirement[],
  label: string,
  moduleId: string,
): void {
  assertUniqueValues(
    requirements.map((requirement) => requirement.id),
    label,
    moduleId,
  )
}

function assertProvidedCapabilities(
  capabilities: readonly CapabilityToken[],
  moduleId: string,
): void {
  assertUniqueValues(
    capabilities.map((capability) => capability.id),
    'provided capability',
    moduleId,
  )
  for (const capability of capabilities) {
    assertSemanticVersion(capability.version)
  }
}

export function validateManifest(
  manifest: KernelModuleManifest,
  apiVersion: number,
): void {
  assertNonEmpty(manifest.id, 'module id')
  assertSemanticVersion(manifest.version)
  if (!Number.isInteger(manifest.apiVersion) || manifest.apiVersion <= 0) {
    throw new KernelHostError(
      'INVALID_MANIFEST',
      `Module "${manifest.id}" has an invalid apiVersion`,
      { moduleId: manifest.id },
    )
  }
  if (manifest.apiVersion !== apiVersion) {
    throw new KernelHostError(
      'API_VERSION_MISMATCH',
      `Module "${manifest.id}" requires kernel API ${manifest.apiVersion}, host provides ${apiVersion}`,
      { moduleId: manifest.id },
    )
  }
  if (!['in-process', 'worker', 'sidecar'].includes(manifest.isolation)) {
    throw new KernelHostError(
      'INVALID_MANIFEST',
      `Module "${manifest.id}" has invalid isolation "${manifest.isolation}"`,
      { moduleId: manifest.id },
    )
  }

  assertProvidedCapabilities(manifest.provides, manifest.id)
  assertRequirements(manifest.requires, 'required capability', manifest.id)
  assertRequirements(
    manifest.optionalRequires,
    'optional capability',
    manifest.id,
  )
  assertUniqueValues(manifest.permissions, 'permission', manifest.id)

  const requiredIds = new Set(
    manifest.requires.map((requirement) => requirement.id),
  )
  for (const requirement of manifest.optionalRequires) {
    if (!requiredIds.has(requirement.id)) continue
    throw new KernelHostError(
      'INVALID_MANIFEST',
      `Module "${manifest.id}" declares capability "${requirement.id}" as both required and optional`,
      { moduleId: manifest.id, capabilityId: requirement.id },
    )
  }
}

function addDependencyEdge(
  providerId: string,
  consumerId: string,
  dependents: Map<string, Set<string>>,
  indegree: Map<string, number>,
): void {
  if (providerId === consumerId) return

  const providerDependents = dependents.get(providerId)!
  if (providerDependents.has(consumerId)) return
  providerDependents.add(consumerId)
  indegree.set(consumerId, indegree.get(consumerId)! + 1)
}

function resolveRequirement(
  consumer: KernelModuleDefinition,
  requirement: CapabilityRequirement,
  providers: ReadonlyMap<string, KernelCapabilityProvider>,
  optional: boolean,
): string | undefined {
  const provider = providers.get(requirement.id)
  if (provider === undefined) {
    if (optional) return undefined
    throw new KernelHostError(
      'MISSING_CAPABILITY',
      `Module "${consumer.manifest.id}" requires missing capability "${requirement.id}"`,
      {
        moduleId: consumer.manifest.id,
        capabilityId: requirement.id,
      },
    )
  }

  if (satisfiesVersionRange(
    provider.capability.version,
    requirement.versionRange,
  )) return provider.moduleId
  if (optional) return undefined

  throw new KernelHostError(
    'VERSION_MISMATCH',
    `Capability "${requirement.id}" from module "${provider.moduleId}" at ${provider.capability.version} does not satisfy ${requirement.versionRange}`,
    {
      moduleId: consumer.manifest.id,
      capabilityId: requirement.id,
      relatedModuleIds: [provider.moduleId],
    },
  )
}

/** Resolves a stable topological order with lexical tie-breaking. */
export function resolveKernelModulePlan(
  modules: ReadonlyMap<string, KernelModuleDefinition>,
  apiVersion: number,
): KernelModulePlan {
  const sortedModules = [...modules.values()].sort((left, right) =>
    compareIdentifiers(left.manifest.id, right.manifest.id))
  const providers = new Map<string, KernelCapabilityProvider>()
  const dependents = new Map<string, Set<string>>()
  const indegree = new Map<string, number>()

  for (const module of sortedModules) {
    validateManifest(module.manifest, apiVersion)
    dependents.set(module.manifest.id, new Set())
    indegree.set(module.manifest.id, 0)
    for (const capability of module.manifest.provides) {
      const existingProvider = providers.get(capability.id)
      if (existingProvider !== undefined) {
        throw new KernelHostError(
          'DUPLICATE_CAPABILITY',
          `Capability "${capability.id}" is provided by both "${existingProvider.moduleId}" and "${module.manifest.id}"`,
          {
            capabilityId: capability.id,
            relatedModuleIds: [
              existingProvider.moduleId,
              module.manifest.id,
            ],
          },
        )
      }
      providers.set(capability.id, {
        moduleId: module.manifest.id,
        capability,
      })
    }
  }

  for (const module of sortedModules) {
    for (const requirement of module.manifest.requires) {
      const providerId = resolveRequirement(
        module,
        requirement,
        providers,
        false,
      )!
      addDependencyEdge(
        providerId,
        module.manifest.id,
        dependents,
        indegree,
      )
    }
    for (const requirement of module.manifest.optionalRequires) {
      const providerId = resolveRequirement(
        module,
        requirement,
        providers,
        true,
      )
      if (providerId !== undefined) {
        addDependencyEdge(
          providerId,
          module.manifest.id,
          dependents,
          indegree,
        )
      }
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([moduleId]) => moduleId)
    .sort()
  const order: string[] = []

  while (ready.length > 0) {
    const moduleId = ready.shift()!
    order.push(moduleId)
    const nextIds = [...dependents.get(moduleId)!].sort()
    for (const nextId of nextIds) {
      const nextDegree = indegree.get(nextId)! - 1
      indegree.set(nextId, nextDegree)
      if (nextDegree === 0) {
        ready.push(nextId)
        ready.sort()
      }
    }
  }

  if (order.length !== modules.size) {
    const cyclicModuleIds = [...indegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([moduleId]) => moduleId)
      .sort()
    throw new KernelHostError(
      'CYCLIC_DEPENDENCY',
      `Kernel module dependency cycle: ${cyclicModuleIds.join(', ')}`,
      { relatedModuleIds: cyclicModuleIds },
    )
  }

  return {
    order: Object.freeze(order),
    capabilityProviders: new Map(providers),
  }
}
