/**
 * 技能索引的成文：把一批只挂链接、不注入全文的技能渲染成「# 命中 Skill」那一段，
 * 以及把技能定义削成不含全文的 descriptor。都只看传进来的数据，不碰仓库状态。
 */

import { isEmpty } from '@velaros-ai/core'

import type { AgentSkillDescriptor } from '../../types/agent.js'
import type { AgentSkillDefinition } from '../../types/guidance.js'

/**
 * 渲染「# 命中 Skill」段：用户显式选中的排在前面、措辞是硬指令（选中即指令，说软了模型会自行跳过），
 * 泛化命中的排在后面、措辞是可选读取。两组都只给 `skill:<id>` 链接与一句描述，正文按需 tooling:read。
 * 一条都没有时返回空串，调用方据此整段不拼进提示词。
 */
export function formatLinkedSkillPrompt(
  skills: readonly AgentSkillDefinition[],
  selected: ReadonlySet<string> = new Set()
): string {
  if (isEmpty(skills)) return ''

  const formatLine = (skill: AgentSkillDefinition): string => {
    const description = skill.description?.replace(/\s+/gu, ' ').trim()
    return description
      ? `- skill:${skill.id}：${skill.label}。${description}`
      : `- skill:${skill.id}：${skill.label}`
  }
  const selectedSkills = skills.filter((skill) => selected.has(skill.id))
  const matchedSkills = skills.filter((skill) => !selected.has(skill.id))

  const lines = ['# 命中 Skill']
  if (!isEmpty(selectedSkills)) {
    // 用户显式选中 ≠ 泛化命中：选中即指令，回答前必须先读并遵循——措辞太软会被模型自主裁量跳过。
    lines.push(
      '',
      '用户为本次请求**显式选择**了以下 Skill。开始实质回答前必须先用 tooling:read 读取其正文并严格遵循（读取已免确认）：',
      ...selectedSkills.map(formatLine)
    )
  }
  if (!isEmpty(matchedSkills)) {
    lines.push(
      '',
      '以下 Skill 与当前请求匹配，正文不直接注入；需要时调用 tooling:read 读取：',
      ...matchedSkills.map(formatLine)
    )
  }

  lines.push('', '读取格式：tooling:read({ ids: ["skill:<id>"], detail: "full" })')
  return lines.join('\n')
}

/**
 * 把一条技能定义削成对外的 descriptor：摘掉全文 markdown 与只在仓库内部用的档位、可见性字段，
 * 留下模型据以决定「要不要去读它」的那些。列技能给模型看时走这里，避免把全文顺手泄出去。
 */
export function toSkillDescriptor(skill: AgentSkillDefinition): AgentSkillDescriptor {
  const {
    markdown: _markdown,
    skillKind: _skillKind,
    autoInjectPromptFeatures: _autoInjectPromptFeatures,
    enabled: _enabled,
    capabilityScopes: _capabilityScopes,
    ...descriptor
  } = skill
  return descriptor
}
