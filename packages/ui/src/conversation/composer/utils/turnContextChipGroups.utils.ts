import type { TurnContextDelta, TurnContextSourceId } from '#contracts'

export interface TurnContextChipGroup {
  id: string
  sourceId: TurnContextSourceId
  deltas: TurnContextDelta[]
  label: string
  title: string
}

function resolveChipGroupLabel(delta: TurnContextDelta): string {
  if (delta.sourceId !== 'workspace.filesystem-touches') return delta.label

  // 兼容修复前已经进入内存账本的“文件变化 ×N”标签。文件变化的数量由统一分组层负责，
  // source 只提供稳定标签，否则不同批次会被拆成多枚 chip，并再次追加一个 ×N。
  return delta.label.replace(/\s+×\d+$/u, '')
}

/**
 * 环境上下文 chip 的统一展示分组。底层 delta 保持不变，仅合并同来源、同稳定标签的
 * 展示项；composer 删除一组时仍能逐项 dismiss，发送后气泡也复用同一标签。
 */
export function groupTurnContextChips(deltas: readonly TurnContextDelta[]): TurnContextChipGroup[] {
  const groups: TurnContextChipGroup[] = []
  const groupsBySource = new Map<TurnContextSourceId, Map<string, number>>()

  for (const delta of deltas) {
    const baseLabel = resolveChipGroupLabel(delta)
    let groupsByLabel = groupsBySource.get(delta.sourceId)
    if (!groupsByLabel) {
      groupsByLabel = new Map<string, number>()
      groupsBySource.set(delta.sourceId, groupsByLabel)
    }

    const existingIndex = groupsByLabel.get(baseLabel)
    if (existingIndex === undefined) {
      groupsByLabel.set(baseLabel, groups.length)
      groups.push({
        id: delta.id,
        sourceId: delta.sourceId,
        deltas: [delta],
        label: baseLabel,
        title: delta.summaryText,
      })
      continue
    }

    const group = groups[existingIndex]!
    group.deltas.push(delta)
    group.label = `${baseLabel} ×${group.deltas.length}`
    group.title = group.deltas.map((item) => item.summaryText).join('\n')
  }

  return groups
}
