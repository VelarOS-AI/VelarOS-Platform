// AgentModLoader 用到的纯函数（不碰实例状态）。
import { isArray, isPlainObject } from '@velaros-ai/core'

import type { AgentModContributionAxisName, AgentModManifest } from '../../types/agent.js'
import type { AgentModBindings } from '../../types/mods.js'

/** 取某条贡献轴上的绑定记录；形状不对就当空表。 */
export function readBindingRecord(
  bindings: AgentModBindings,
  axis: AgentModContributionAxisName
): Readonly<Record<string, unknown>> {
  const record = Reflect.get(bindings, axis)
  return isPlainObject(record) ? record : {}
}

/** 取清单里某条贡献轴的条目数组；形状不对就当空数组。 */
export function readAxisEntries(
  manifest: AgentModManifest,
  axis: AgentModContributionAxisName
): readonly unknown[] {
  const entries = Reflect.get(manifest.contributes, axis)
  return isArray(entries) ? entries : []
}
