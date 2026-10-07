import { isEmpty } from '@velaros-ai/core'
import type { ModuleDescription } from '@velaros-ai/kernel'
import type { ScriptPackageDefinition } from '@velaros-ai/script'

import type { RuntimeCapabilityHint, RuntimeInventory } from '../types/inventory.js'

import { ActRuntimeTuning } from './tuning.js'

/** 能力按实际公共导入入口列出；系统成员仍从组合包导入。 */
export function capabilityHints(
  modules: readonly ModuleDescription[],
  packages: readonly ScriptPackageDefinition[]
): RuntimeCapabilityHint[] {
  return modules.flatMap((description) => {
    const entries = packages.flatMap((pkg) =>
      Object.entries(pkg.exports)
        .filter(([, module]) => module === description.binding.moduleId)
        .map(([member]) => ({
          module: pkg.specifier,
          member,
          summary: description.summary,
        }))
    )
    return !isEmpty(entries)
      ? entries
      : [{ module: description.binding.moduleId, summary: description.summary }]
  })
}

/** 索引进入动态帧并计入预算；长目录折叠时保留完整数量与发现入口。 */
export function boundedInventory(input: RuntimeInventory, maxChars: number): RuntimeInventory {
  const capabilities = input.capabilities.map((item) => ({
    ...item,
    summary: item.summary.slice(0, ActRuntimeTuning.inventorySummaryChars),
  }))
  const packages = input.packages.map((item) => ({
    ...item,
    error: item.error?.slice(0, ActRuntimeTuning.inventorySummaryChars),
  }))
  const skills = input.skills.map((item) => ({
    ...item,
    description: item.description.slice(0, ActRuntimeTuning.inventorySummaryChars),
  }))
  const result = {
    ...input,
    capabilities,
    packages,
    skills,
    npm: input.npm && {
      ...input.npm,
      error: input.npm.error?.slice(0, ActRuntimeTuning.inventorySummaryChars),
    },
  }
  const groups = [capabilities, packages, skills]
  while (JSON.stringify(result).length > maxChars) {
    const largest = groups
      .filter((group) => !isEmpty(group))
      .sort((left, right) => JSON.stringify(right).length - JSON.stringify(left).length)[0]
    if (!largest) break
    largest.pop()
  }
  return result
}
