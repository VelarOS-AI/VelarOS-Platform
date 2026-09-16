// 域：`op:"read"` —— 读取当前角色可见的技能正文（`skill:<id>`）。工具空间五个 op 里唯一
// 不碰工具页的一个：它读的是**行为知识**，不改变任何工具的可见性或驻留状态。
//
// ## 从哪读起
// 只有一条链：`readRequestedSkillPages` → 逐个 id → `readRequestedSkillPage`
// （`readSkillPageId` 认前缀 + 注入侧 `skills.readRoleSkill` 取正文）→ `buildSkillReadPage` 定形。
// 前置是 `confirmAutoLoadedSkillPages`：内置/用户显式选择的技能直接读取；未选择的外部技能首次
// 读取会向用户征求同意，被拒的 id 直接跳过。
//
// ## 关键不变量
//  1. **被拒 id 必须写进返回文案且明说"不要重试"**。只是静默跳过的话，模型会把空结果当成
//     偶发失败并反复重读同一个技能，把用户的拒绝变成骚扰循环。
//  2. **技能正文不改变工具可见性**。返回文案要把模型引回工具空间流程，否则它会把读到的步骤
//     当成工具已可用的凭据。
//  3. 本文件不认识任何具体技能，只有形状与流程。语义中立门（`check:agent-arch` 防线⑤）连注释一起扫。
//
// ## 历史
// 这里曾同时读「工具页 schema 预览」，那是旧的「工具默认隐藏 → 换入前先预览 schema」范式的产物。
// 工具暴露改为「填满预算常驻」后，需要的 schema 大多已直接在本轮 tools 列表里可见，预览与配套的
// 重复深读拦截整套已无价值并一并退役。缺 id 时的返回文案仍负责把模型推回 find / replace。

import { type z } from 'zod'

import { isEmpty, optionalWhenLazy } from '@velaros-ai/core'

import type { AgentSkillDescriptor } from '../../types/agent.js'
import type { SkillReadPage } from '../../types/builtin.js'
import type { KernelToolContext as ToolContext } from '../../types/tool-context.js'

import {
  confirmAutoLoadedSkillPages,
  readSkillPageId,
  SkillPagePrefix,
} from './skill-load-confirmation'
import { type toolSpaceReadSchema } from './tool-space-schemas'

/**
 * 把一条技能的 descriptor 加正文定形成模型能看到的 `SkillReadPage`：id 统一带 `skill:` 前缀，
 * `description` 缺省时退回 `label`（不留空字段）。只有 `detail === 'full'` 才附上 `readGuidance`
 * 两句——提醒模型按需取用步骤、且技能正文**不改变工具可见性**；这两句是不变量②的落点。
 */
function buildSkillReadPage(
  descriptor: AgentSkillDescriptor,
  markdown: string,
  detail: z.output<typeof toolSpaceReadSchema>['detail']
): SkillReadPage {
  return {
    id: `${SkillPagePrefix}${descriptor.id}`,
    kind: 'skill',
    name: descriptor.id,
    label: descriptor.label,
    description: descriptor.description ?? descriptor.label,
    sourceKind: descriptor.sourceKind,
    sourceId: descriptor.sourceId,
    roleIds: descriptor.roleIds,
    priority: descriptor.priority,
    markdown,
    fullDetails: optionalWhenLazy(detail === 'full', () => ({
      readGuidance: [
        '这是当前角色和 selectedSkillIds 下可见的技能正文；按需读取后只应用与当前任务相关的步骤。',
        '技能正文不会改变工具可见性；需要新工具仍按 tooling:map / tooling:replace 的工具空间流程处理。',
      ],
    })),
  }
}

/**
 * 读单个技能页：id 不带 `skill:` 前缀、或当前角色的 `skills.readRoleSkill` 取不到正文，都返回 null；
 * 两种 null 上游一律归到 `missingIds`，不区分「不是技能页」和「技能不存在」——对模型来说都是这个
 * id 读不出东西，得回工具空间流程重找。
 */
function readRequestedSkillPage(
  ctx: ToolContext,
  id: string,
  detail: z.output<typeof toolSpaceReadSchema>['detail']
): Nullable<SkillReadPage> {
  const skillId = readSkillPageId(id)
  if (!skillId) return null

  const skill = ctx.skills?.readRoleSkill?.(skillId)
  if (!skill) return null

  return buildSkillReadPage(skill.descriptor, skill.markdown, detail)
}

/** 读取当前角色可见的技能正文（skill:<id>）；被用户拒绝的 id 跳过并在文案里点名。 */
export async function readRequestedSkillPages(
  ctx: ToolContext,
  input: z.output<typeof toolSpaceReadSchema>
) {
  const deniedSkillPageIds = await confirmAutoLoadedSkillPages(ctx, input.ids)
  const pages: SkillReadPage[] = []
  const missingIds: string[] = []
  const deniedSkillIds: string[] = []

  for (const id of input.ids) {
    if (deniedSkillPageIds.has(id)) {
      deniedSkillIds.push(id)
      continue
    }

    const skillPage = readRequestedSkillPage(ctx, id, input.detail)
    if (skillPage) {
      pages.push(skillPage)
      continue
    }

    missingIds.push(id)
  }

  return {
    op: 'read' as const,
    pages,
    missingIds,
    deniedSkillIds: optionalWhenLazy(!isEmpty(deniedSkillIds), () => deniedSkillIds),
    message: !isEmpty(deniedSkillIds)
      ? `用户拒绝读取技能：${deniedSkillIds.join('、')}。不要再次尝试读取这些技能，按用户意图继续当前任务。`
      : isEmpty(missingIds)
        ? '已读取技能正文。'
        : `部分技能 id 不存在：${missingIds.join('、')}。技能列表见任务提示词里「# 命中 Skill」那一段；tooling:read 只读 skill:<id>，工具能力请用 tooling:map 发现、tooling:replace 换入。`,
  }
}
