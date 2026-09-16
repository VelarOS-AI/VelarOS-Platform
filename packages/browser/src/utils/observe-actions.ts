import { isEmpty,isNonBlankString } from '@velaros-ai/core'

import type {
  BrowserElementTargetHint,
  BrowserObserveActionsResult,
  BrowserObservedActionCandidate,
  BrowserObservedActionInput,
  BrowserObservedActionKind,
  BrowserObservedActionPreview,
  BrowserPageAction,
  BrowserPageFormField,
  BrowserPageInspection,
} from '../types/browser'
import type { ObserveActionDraft } from '../types/tools.js'

import { clampInteger } from './numbers.js'


/** 按意图给候选动作排序、截断，拼成回执。 */
export function buildObserveActionsResult(
  inspection: BrowserPageInspection,
  instruction: Optional<string>,
  limit: number
): BrowserObserveActionsResult {
  const tokens = tokenizeObserveInstruction(instruction)
  const candidates = buildObserveActionDrafts(inspection)
    .map((draft) => ({
      draft,
      score: scoreObserveActionDraft(draft, tokens),
    }))
    .filter((entry) => isEmpty(tokens) || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.draft.index - right.draft.index)
    .slice(0, limit)
    .map(({ draft, score }) => formatObservedActionCandidate(draft, score))

  return {
    url: inspection.url,
    title: inspection.title,
    instruction: instruction?.trim() || null,
    candidates,
    capturedAt: Date.now(),
  }
}

/** observe_actions 的候选条数上界：域内常量集中在这里，钳制算法走全包单源 `clampInteger`。 */
export function clampObserveActionLimit(limit: LooseOptional<number>): number {
  return clampInteger(limit, 1, 80, 20)
}

/** 把一次页面检查的可交互元素变成候选动作草稿。 */
function buildObserveActionDrafts(inspection: BrowserPageInspection): ObserveActionDraft[] {
  const drafts: ObserveActionDraft[] = []
  let index = 0
  for (const field of inspection.formFields) {
    if (!field.target) continue

    const method = resolveFormFieldActionMethod(field)
    const requiresValue = method === 'fill' || method === 'select' || method === 'upload'
    drafts.push({
      method,
      description: `${describeTargetActionMethod(method)} ${describeFormField(field)}`,
      source: 'form_field',
      target: field.target,
      twoStep: false,
      priority: method === 'upload' ? 5 : 3,
      requiresValue,
      arguments: method === 'upload' ? ['filePath'] : requiresValue ? ['value'] : [],
      searchableText: [
        field.label,
        field.type,
        field.name,
        field.placeholder,
        field.target.text,
        field.target.name,
        field.target.role,
        ...Object.values(field.target.attributes),
      ].join(' '),
      index,
    })
    index += 1
  }

  for (const action of inspection.actions) {
    if (!action.target) continue

    const twoStep = isCustomDropdownAction(action)
    const option = isDropdownOptionAction(action)
    drafts.push({
      method: 'click',
      description: `${twoStep ? 'Open' : option ? 'Choose' : 'Click'} ${action.text || action.role}`,
      source: 'action',
      target: action.target,
      twoStep,
      priority: option ? 4 : 2,
      requiresValue: false,
      arguments: [],
      searchableText: [
        action.text,
        action.role,
        action.target.text,
        action.target.name,
        action.target.role,
        ...Object.values(action.target.attributes),
      ].join(' '),
      index,
    })
    index += 1
  }

  for (const link of inspection.links) {
    if (!link.target) continue

    drafts.push({
      method: 'click',
      description: `Open ${link.text || link.href}`,
      source: 'link',
      target: link.target,
      twoStep: false,
      priority: 1,
      requiresValue: false,
      arguments: [],
      searchableText: [
        link.text,
        link.href,
        link.target.text,
        link.target.name,
        link.target.role,
        ...Object.values(link.target.attributes),
      ].join(' '),
      index,
    })
    index += 1
  }

  return drafts
}

/** 判一个候选是不是下拉里的某一项。 */
function isDropdownOptionAction(action: BrowserPageAction): boolean {
  const target = action.target
  const role = target?.role?.toLowerCase() || action.role.toLowerCase()
  return role === 'option' || role === 'menuitem'
}

/** 判一个候选是不是自定义下拉（不是原生 select）。 */
function isCustomDropdownAction(action: BrowserPageAction): boolean {
  const target = action.target
  if (!target) return false

  const role = target.role?.toLowerCase() || action.role.toLowerCase()
  const popup = target.attributes['aria-haspopup']?.toLowerCase()
  return role === 'combobox' || popup === 'listbox' || popup === 'menu'
}

/** 按字段类型决定该用填值、点击还是选项。 */
function resolveFormFieldActionMethod(field: BrowserPageFormField): BrowserObservedActionKind {
  const type = field.type.toLowerCase()
  if (type === 'file' || field.target?.attributes.type?.toLowerCase() === 'file') return 'upload'
  if (type === 'checkbox' || type === 'radio') return 'check'
  if (type === 'select' || field.target?.role?.toLowerCase() === 'combobox') return 'select'

  return 'fill'
}

/** 把动作方式（点击、填值、选项）翻成一句人话。 */
function describeTargetActionMethod(method: BrowserObservedActionKind): string {
  switch (method) {
    case 'upload':
      return 'Upload'
    case 'fill':
      return 'Fill'
    case 'select':
      return 'Select'
    case 'check':
      return 'Check'
    case 'uncheck':
      return 'Uncheck'
    case 'focus':
      return 'Focus'
    case 'hover':
      return 'Hover'
    default:
      return 'Click'
  }
}

/** 用一句话描述一个表单字段，供候选列表显示。 */
function describeFormField(field: BrowserPageFormField): string {
  return (
    field.label ||
    field.placeholder ||
    field.name ||
    field.target?.text ||
    field.type ||
    'form field'
  )
}

/** 把意图切成词，用来给候选动作打分。 */
function tokenizeObserveInstruction(instruction: Optional<string>): string[] {
  return String(instruction ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter(isNonBlankString)
}

/** 按意图里的词给候选动作打分，分高的排前面。 */
function scoreObserveActionDraft(draft: ObserveActionDraft, tokens: string[]): number {
  if (isEmpty(tokens)) return draft.priority

  const haystack = draft.searchableText.toLowerCase()
  const tokenScore = tokens.reduce((score, token) => haystack.includes(token) ? score + token.length + 1 : score, 0)
  if (tokenScore <= 0) return 0

  return tokenScore + draft.priority
}

/** 把一个候选动作格式化成回执里的一行。 */
function formatObservedActionCandidate(
  draft: ObserveActionDraft,
  score: number
): BrowserObservedActionCandidate {
  const idRef = draft.target.ref?.trim()
  const id = idRef || `${draft.source}-${draft.index}`
  const actionId = formatObservedActionId(draft)
  if (draft.method === 'upload') {
    const uploadInput = {
      target: draft.target,
      filePath: '',
    }
    return {
      id,
      actionId,
      method: draft.method,
      description: draft.description,
      source: draft.source,
      score,
      twoStep: draft.twoStep,
      requiresValue: draft.requiresValue,
      arguments: draft.arguments,
      preview: buildObservedActionPreview(draft, id),
      replay: {
        tool: 'browser:upload_file',
        input: uploadInput,
      },
      target: draft.target,
    }
  }

  const actionInput: BrowserObservedActionInput = {
    action: 'target',
    targetAction: draft.method,
    target: draft.target,
  }
  return {
    id,
    actionId,
    method: draft.method,
    description: draft.description,
    source: draft.source,
    score,
    twoStep: draft.twoStep,
    requiresValue: draft.requiresValue,
    arguments: draft.arguments,
    preview: buildObservedActionPreview(draft, id),
    replay: {
      tool: 'browser:act',
      input: actionInput,
    },
    target: draft.target,
    actionInput,
  }
}

/** 给候选动作编一个稳定的短 id。 */
function formatObservedActionId(draft: ObserveActionDraft): string {
  return [
    `${draft.source}-${draft.index}`,
    draft.method,
    describeObservedActionTarget(draft.target, `${draft.source}-${draft.index}`),
  ].join(':')
}

/** 给一个候选动作拼出「照着填就能跑」的预览命令。 */
function buildObservedActionPreview(
  draft: ObserveActionDraft,
  fallbackTarget: string
): BrowserObservedActionPreview {
  const target = describeObservedActionTarget(draft.target, fallbackTarget)
  const command = draft.method === 'upload'
    ? `browser:upload_file ${target} <filePath>`
    : `browser:act target ${draft.method} ${target}`
  return {
    label: draft.description,
    target,
    command,
    requiresValue: draft.requiresValue,
    twoStep: draft.twoStep,
  }
}

/** 用一句话描述候选动作的目标元素。 */
function describeObservedActionTarget(
  target: BrowserElementTargetHint,
  fallback: string
): string {
  return (
    normalizeObservedActionText(target.ref) ||
    normalizeObservedActionText(target.css) ||
    normalizeObservedActionText(target.text) ||
    normalizeObservedActionText(target.name) ||
    normalizeObservedActionText(target.role) ||
    fallback
  )
}

/** 把元素文本压成单行、去掉多余空白，便于比对与显示。 */
function normalizeObservedActionText(value: LooseOptional<string>): string {
  return value?.replace(/\s+/g, ' ').trim() || ''
}
