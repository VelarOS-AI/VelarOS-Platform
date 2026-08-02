import type { KernelToolContext as ToolContext } from '../KernelToolContext'

const SkillPagePrefix = 'skill:'

/** 解析 tooling:read 的技能页 id（skill:<id>）；非技能页返回 null。 */
function readSkillPageId(id: string): Nullable<string> {
  const trimmed = id.trim()
  if (!trimmed.toLowerCase().startsWith(SkillPagePrefix)) return null

  const skillId = trimmed.slice(SkillPagePrefix.length).trim()
  return skillId || null
}

function buildSkillLoadConfirmationMessage(skill: {
  label: string
  id: string
  description?: string
}): string {
  return [
    '技能加载申请',
    '',
    `技能：${skill.label}（${skill.id}）`,
    ...(skill.description ? [`用途：${skill.description}`] : []),
    '',
    '模型判断该技能与当前任务相关，希望读取其完整正文。',
    '同意后本会话内再次读取同一技能不再询问；拒绝后模型会不使用该技能继续。',
  ].join('\n')
}

/**
 * 模型自动读取技能前的用户确认：
 * 用户通过 / 显式选中的技能免确认；同一技能本会话批准一次后自动放行（riskScope）。
 * 返回被拒绝的技能页 id 集合。
 */
async function confirmAutoLoadedSkillPages(
  ctx: ToolContext,
  ids: readonly string[]
): Promise<Set<string>> {
  const denied = new Set<string>()

  for (const id of ids) {
    const skillId = readSkillPageId(id)
    if (!skillId) continue
    if (ctx.skills?.isSkillSelected?.(skillId)) continue

    const skill = ctx.skills?.readRoleSkill?.(skillId)
    // 内置技能属于系统能力，读取不需要额外确认。
    if (!skill || skill.descriptor.sourceKind === 'builtin') continue

    const decision = await ctx.approval.awaitConfirmationDecision(
      buildSkillLoadConfirmationMessage({
        label: skill.descriptor.label,
        id: skillId,
        description: skill.descriptor.description,
      }),
      ctx.abortSignal,
      {
        approvalRisk: 'low',
        riskScope: `skill-load:${skillId}`,
      }
    )
    if (!decision.approved) denied.add(id)
  }

  return denied
}

export { confirmAutoLoadedSkillPages, readSkillPageId, SkillPagePrefix }
