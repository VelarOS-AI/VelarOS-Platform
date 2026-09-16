import { isBlank, isEmpty,isNotUndefined, isUndefined } from '@velaros-ai/core';

import type { CapabilityRequirement, CapabilityToken } from '../../types/abi-capability'
import {
  type KernelModuleDefinition,
  KernelModuleIsolationValues,
  type KernelModuleManifest,
} from '../../types/abi-module'
import { KernelError } from '../errors'

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
  if (!isBlank(value.trim())) return

  throw new KernelError(
    'INVALID_MANIFEST',
    `${label} 不能为空`,
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
      throw new KernelError(
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
    throw new KernelError(
      'INVALID_MANIFEST',
      `模块 "${manifest.id}" 的 apiVersion 不合法`,
      { moduleId: manifest.id },
    )
  }
  if (manifest.apiVersion !== apiVersion) {
    throw new KernelError(
      'API_VERSION_MISMATCH',
      `模块 "${manifest.id}" 要求内核 API ${manifest.apiVersion}，本宿主提供的是 ${apiVersion}`,
      { moduleId: manifest.id },
    )
  }
  if (!KernelModuleIsolationValues.includes(manifest.isolation)) {
    throw new KernelError(
      'INVALID_MANIFEST',
      `模块 "${manifest.id}" 的隔离形态 "${manifest.isolation}" 不合法`,
      { moduleId: manifest.id },
    )
  }

  assertProvidedCapabilities(manifest.provides, manifest.id)
  assertRequirements(manifest.requires, '必需能力', manifest.id)
  assertRequirements(
    manifest.optionalRequires,
    '可选能力',
    manifest.id,
  )
  assertUniqueValues(manifest.permissions, 'permission', manifest.id)

  const requiredIds = new Set(
    manifest.requires.map((requirement) => requirement.id),
  )
  for (const requirement of manifest.optionalRequires) {
    if (!requiredIds.has(requirement.id)) continue
    throw new KernelError(
      'INVALID_MANIFEST',
      `模块 "${manifest.id}" 把能力 "${requirement.id}" 同时声明成必需和可选`,
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
  if (isUndefined(provider)) {
    if (optional) return undefined
    throw new KernelError(
      'MISSING_CAPABILITY',
      `模块 "${consumer.manifest.id}" 需要的能力 "${requirement.id}" 没有模块提供`,
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

  throw new KernelError(
    'VERSION_MISMATCH',
    `模块 "${provider.moduleId}" 提供的能力 "${requirement.id}"（${provider.capability.version}）不满足 ${requirement.versionRange}`,
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
      if (isNotUndefined(existingProvider)) {
        throw new KernelError(
          'DUPLICATE_CAPABILITY',
          `能力 "${capability.id}" 被 "${existingProvider.moduleId}" 与 "${module.manifest.id}" 同时声明提供`,
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
      if (isNotUndefined(providerId)) {
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

  while (!isEmpty(ready)) {
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
    throw new KernelError(
      'CYCLIC_DEPENDENCY',
      `内核模块依赖成环：${cyclicModuleIds.join(', ')}`,
      { relatedModuleIds: cyclicModuleIds },
    )
  }

  return {
    order: Object.freeze(order),
    capabilityProviders: new Map(providers),
  }
}
