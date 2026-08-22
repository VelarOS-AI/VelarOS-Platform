import { isEmpty, toNullable } from '@velaros-ai/core'

import type {
  BrowserPageInspection,
  BrowserRecipeSkeleton,
  BrowserRecipeSkeletonLink,
  BrowserRecipeSkeletonStep,
} from './types'

type BrowserRecipeTemplate = 'login' | 'search' | 'pagination' | 'form_submit'

/** C3: Recipe 模板库 — 预设步骤骨架，避免模型每次从零推导 */
const RecipeTemplates: Record<BrowserRecipeTemplate, BrowserRecipeSkeletonStep[]> = {
  login: [
    {
      id: 'tpl_login_fill_username',
      kind: 'fill_field',
      title: '填写用户名 / 邮筱',
      instruction: '在用户名或邮筱输入框中填写账号。',
      input: { name: 'username', label: '用户名 / 邮筱', type: 'text', required: true },
    },
    {
      id: 'tpl_login_fill_password',
      kind: 'fill_field',
      title: '填写密码',
      instruction: '在密码输入框中填写密码。',
      input: { name: 'password', label: '密码', type: 'password', required: true },
    },
    {
      id: 'tpl_login_submit',
      kind: 'click_action',
      title: '点击登录按钮',
      instruction: '点击登录 / 提交按钮完成登录。',
    },
  ],
  search: [
    {
      id: 'tpl_search_fill_query',
      kind: 'fill_field',
      title: '填写搜索关键词',
      instruction: '在搜索输入框中填写搜索内容。',
      input: { name: 'query', label: '搜索关键词', type: 'text', required: true },
    },
    {
      id: 'tpl_search_submit',
      kind: 'click_action',
      title: '提交搜索',
      instruction: '点击搜索按钮或按 Enter 提交。',
    },
    {
      id: 'tpl_search_review',
      kind: 'review_page',
      title: '检查搜索结果',
      instruction: '检查返回的搜索结果列表是否符合预期。',
    },
  ],
  pagination: [
    {
      id: 'tpl_pagination_review_current',
      kind: 'review_page',
      title: '检查当前页内容',
      instruction: '检查当前页面数据是否完整。',
    },
    {
      id: 'tpl_pagination_next',
      kind: 'click_action',
      title: '点击下一页',
      instruction: '点击「下一页」/「下页」/『next』按钮加载下一页。',
      retryCount: 1,
    },
  ],
  form_submit: [
    {
      id: 'tpl_form_review',
      kind: 'review_section',
      title: '检查表单字段',
      instruction: '检查表单中的必填字段列表。',
    },
    {
      id: 'tpl_form_submit',
      kind: 'click_action',
      title: '提交表单',
      instruction: '点击提交按钮完成表单填写。',
    },
  ],
}

/** 根据页面检查结果生成 recipe skeleton。 */
function buildBrowserRecipeSkeleton(
  inspection: BrowserPageInspection,
  sourceSnapshotPath: Nullable<string>
): BrowserRecipeSkeleton {
  // 只保留较高层级标题，作为 recipe 主要分区线索。
  const sectionHeadings = inspection.headings
    .filter((entry) => entry.level <= 3)
    .map((entry) => entry.text)
    .filter(Boolean)
    .slice(0, 8)
  const primaryLinks = collectPrimaryRecipeLinks(inspection.links)
  const suggestedSteps = buildBrowserRecipeSteps(inspection, sectionHeadings, primaryLinks)
  const inputs = suggestedSteps
    .map((step) => step.input)
    .filter((input): input is NonNullable<typeof input> => !!input)

  return {
    version: 1,
    url: inspection.url,
    title: inspection.title,
    summary: buildBrowserRecipeSummary(inspection, sectionHeadings, primaryLinks),
    sourceSnapshotPath,
    sectionHeadings,
    primaryLinks,
    inputs,
    suggestedSteps,
    generatedAt: inspection.capturedAt,
  }
}

/** 将预设模板步骤插入 skeleton 前部。 */
function applyBrowserRecipeTemplate(
  skeleton: BrowserRecipeSkeleton,
  template: BrowserRecipeTemplate
): BrowserRecipeSkeleton {
  const templateSteps = RecipeTemplates[template] ?? []
  const templateInputs = templateSteps
    .map((step) => step.input)
    .filter((input): input is NonNullable<typeof input> => !!input)

  return {
    ...skeleton,
    suggestedSteps: [...templateSteps, ...skeleton.suggestedSteps],
    inputs: [...templateInputs, ...skeleton.inputs],
  }
}

/** 构造 skeleton 摘要。 */
function buildBrowserRecipeSummary(
  inspection: BrowserPageInspection,
  sectionHeadings: string[],
  primaryLinks: BrowserRecipeSkeletonLink[]
): string {
  const parts = [
    inspection.title ? `页面标题是 ${inspection.title}` : null,
    !isEmpty(sectionHeadings) ? `可见主要分区 ${sectionHeadings.length} 个` : null,
    !isEmpty(inspection.actions) ? `主要动作 ${inspection.actions.length} 个` : null,
    !isEmpty(inspection.formFields) ? `表单字段 ${inspection.formFields.length} 个` : null,
    !isEmpty(primaryLinks) ? `可跟进链接 ${primaryLinks.length} 个` : null,
  ].filter(Boolean)

  return parts.join('，') || `为 ${inspection.url} 生成的基础页面 recipe`
}

/** 从页面链接中选取去重后的主要链接。 */
function collectPrimaryRecipeLinks(
  links: BrowserPageInspection['links']
): BrowserRecipeSkeletonLink[] {
  const seen = new Set<string>()
  const results: BrowserRecipeSkeletonLink[] = []

  for (const entry of links) {
    const href = entry.href.trim()
    if (!href || seen.has(href)) {
      continue
    }

    const text = entry.text.trim()
    if (!text) {
      continue
    }

    seen.add(href)
    results.push({
      text,
      href,
      target: (toNullable(entry.target)),
    })

    if (results.length >= 8) {
      break
    }
  }

  return results
}

/** 根据表单、按钮和链接推导基础操作步骤。 */
function buildBrowserRecipeSteps(
  inspection: BrowserPageInspection,
  sectionHeadings: string[],
  primaryLinks: BrowserRecipeSkeletonLink[]
): BrowserRecipeSkeletonStep[] {
  const steps: BrowserRecipeSkeletonStep[] = [
    {
      id: 'review-page',
      kind: 'review_page',
      title: 'Review current page',
      instruction: `确认当前页面标题、正文摘要和整体布局是否符合预期：${inspection.title || inspection.url}`,
    },
  ]

  if (sectionHeadings[0]) {
    steps.push({
      id: 'review-primary-section',
      kind: 'review_section',
      title: 'Review primary section',
      heading: sectionHeadings[0],
      instruction: `优先检查主要分区“${sectionHeadings[0]}”中的结构和关键交互点。`,
    })
  }

  const usedInputNames = new Set<string>()
  inspection.formFields.slice(0, 5).forEach((field, index) => {
    // 表单字段会变成 recipe 输入，执行时由调用方传具体值。
    const inputName = buildUniqueBrowserRecipeInputName(
      buildBrowserRecipeInputName(field.name || field.label, index),
      usedInputNames
    )
    steps.push({
      id: index === 0 ? 'fill-primary-field' : `fill-field-${inputName.replace(/_/g, '-')}`,
      kind: 'fill_field',
      title: index === 0 ? 'Fill primary field' : `Fill ${field.label}`,
      text: field.label,
      target: (toNullable(field.target)),
      input: {
        name: inputName,
        label: field.label,
        type: field.type || 'text',
        required: field.required,
      },
      instruction: `将字段“${field.label}”参数化为 recipe 输入，并在执行时填入对应值。`,
    })
  })

  if (inspection.actions[0]) {
    const action = inspection.actions[0]
    steps.push({
      id: 'click-primary-action',
      kind: 'click_action',
      title: 'Click primary action',
      text: action.text,
      target: (toNullable(action.target)),
      instruction: `在确认前置条件后，点击主要动作“${action.text}”，并记录触发后的页面变化。`,
    })
  }

  if (primaryLinks[0]) {
    steps.push({
      id: 'follow-primary-link',
      kind: 'follow_link',
      title: 'Follow primary link',
      href: primaryLinks[0].href,
      text: primaryLinks[0].text,
      target: (toNullable(primaryLinks[0].target)),
      instruction: `如果需要继续探索流程，优先跟进链接“${primaryLinks[0].text}”。`,
    })
  }

  if (primaryLinks.length > 1) {
    steps.push({
      id: 'extract-link-options',
      kind: 'extract_links',
      title: 'Extract alternative links',
      instruction: '整理当前页面其余可操作链接，作为后续流程分支候选。',
    })
  }

  return steps
}

/** 将字段名/标签转成 recipe input 名。 */
function buildBrowserRecipeInputName(value: LooseOptional<string>, index = 0): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

  return normalized || `field_${index + 1}`
}

/** 保证同一个 skeleton 内 input 名不重复。 */
function buildUniqueBrowserRecipeInputName(value: string, usedInputNames: Set<string>): string {
  let candidate = value
  let suffix = 2
  while (usedInputNames.has(candidate)) {
    candidate = `${value}_${suffix}`
    suffix += 1
  }

  usedInputNames.add(candidate)
  return candidate
}

export { applyBrowserRecipeTemplate, type BrowserRecipeTemplate,buildBrowserRecipeSkeleton }
