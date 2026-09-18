// 域：`velar:project` 的 edit 编译。计划是一份按步骤推进的「未来视图」：每个路径在计划里的文件身份、
// fileRef / sourceRef 绑定到的身份，以及排好的事务操作。只生成计划，不读写磁盘，读取都经过 resolver。
import { isEmpty, isUndefined, toOptional } from '@velaros-ai/core'
import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { PrepareEditInput } from '../../types/edit.js'
import type { FileIdentity, ProjectFilePlanState, ProjectPlanFileAction, ProjectPlannerResolver, ProjectRecodeAction, SourceSelection } from '../../types/editing.js'
import type { ProjectContentEdit, ProjectEditInput, ProjectEditStep, ProjectRecodeNewline, ProjectStepSource } from '../../types/files.js'
import { ProjectError } from '../errors.js'
import { normalizeProjectInputText } from '../text.js'

import { applyProjectMutations } from './content-planner.js'
import { advanceProjectCoverage, completeProjectCoverage, coversWholeProjectFile } from './planner-coverage.js'
import { selectProjectMutations } from './select.js'
import { createProjectSourceCoordinates, normalizePhysicalNewlines, sourceNewlineAt } from './source.js'

/** recode 动作要的目标磁盘编码；gb18030 没有 BOM，要求带 BOM 时拒绝。 */
function recodeTargetEncoding(action: ProjectRecodeAction): TextEncoding {
  const encoding = action.encoding ?? 'utf-8'
  const bom = !!action.bom
  if (encoding === 'gb18030') {
    if (bom) throw new ProjectError('INVALID_INPUT', 'gb18030 没有 BOM，请去掉 bom 或改用 utf-8/utf-16。')
    return 'gb18030'
  }
  if (encoding === 'utf-8') return bom ? 'utf8-bom' : 'utf8'
  if (encoding === 'utf-16le') return bom ? 'utf16le' : 'utf16le-nobom'
  return bom ? 'utf16be' : 'utf16be-nobom'
}

/** 按 recode 动作统一物理换行；没指定换行时原样返回。 */
function convertNewlines(content: string, newline?: ProjectRecodeNewline): string {
  if (!newline) return content
  const lf = content.replace(/\r\n/gu, '\n')
  return newline === 'lf' ? lf : lf.replace(/\n/gu, '\r\n')
}

/** 回执里给模型看的格式名：编码、带不带 BOM、换行写法（lf、crlf、mixed、none）。 */
function describeTextFormat(encoding: TextEncoding, content: string): string {
  const label = encoding === 'gb18030' ? 'gb18030'
    : encoding.startsWith('utf16le') ? 'utf-16le'
      : encoding.startsWith('utf16be') ? 'utf-16be' : 'utf-8'
  const bom = encoding === 'utf8-bom' || encoding === 'utf16le' || encoding === 'utf16be'
  const crlf = content.includes('\r\n')
  const lf = /(?:^|[^\r])\n/u.test(content)
  const newline = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none'
  return `${label}${bom ? '+bom' : ''} ${newline}`
}

/** 开一份空计划。 */
function createFilePlan(resolver: ProjectPlannerResolver): ProjectFilePlanState {
  return { resolver, paths: new Map(), references: new Map(), operations: [], baseRevisions: {}, recode: { converted: [], unchanged: [] } }
}

/** 路径里带通配符（`*`、`?`、`[]`、`{}`）就当 glob，交给 resolver 展开。 */
function isGlobPattern(path: string): boolean {
  return /[*?[\]{}]/u.test(path)
}

/**
 * 把 recode 的 paths 展开成实际文件路径：写成 glob 的按项目的列举规则展开（遵守读取策略与 .gitignore），
 * 一个都没匹配上就按找不到目标拒绝；写成精确路径的原样保留，存不存在由后面的读取判定。
 */
async function expandRecodePaths(plan: ProjectFilePlanState, paths: readonly string[]): Promise<string[]> {
  const expanded: string[] = []
  for (const [pathIndex, raw] of paths.entries()) {
    if (!isGlobPattern(raw)) {
      expanded.push(raw)
      continue
    }
    const matched = await plan.resolver.listPaths(raw)
    if (isEmpty(matched))
      throw new ProjectError('TARGET_NOT_FOUND', `${raw} 没有匹配到任何文件。`, { path: raw, pathIndex },
        '用 list 按同一条 glob 看看能列出什么，再把路径或 glob 改对。')
    expanded.push(...matched)
  }
  if (expanded.length > ProjectFileLimits.recodePaths)
    throw new ProjectError('SCOPE_VIOLATION', `展开后有 ${expanded.length} 个文件，超过一次 ${ProjectFileLimits.recodePaths} 个的上限。`,
      { actual: expanded.length, maximum: ProjectFileLimits.recodePaths },
      '把 glob 收窄，或者按目录分几次调用。')
  return expanded
}

/** 按路径批量转换磁盘编码；正文不变的文件跳过，已在本计划改动的文件拒绝，避免两套坐标叠加。 */
async function recodePlanFiles(plan: ProjectFilePlanState, action: ProjectRecodeAction): Promise<void> {
  const target = recodeTargetEncoding(action)
  const seen = new Set<string>()
  for (const [pathIndex, raw] of (await expandRecodePaths(plan, action.paths)).entries()) {
    try {
      const observed = await plan.resolver.readText(raw)
      if (seen.has(observed.path)) continue
      seen.add(observed.path)
      if (plan.paths.has(observed.path))
        throw new ProjectError('INVALID_INPUT', '本计划已改动的文件不能再转换编码；请先提交前面的改动。', { path: observed.path })
      const content = convertNewlines(observed.content, action.newline)
      if (observed.textEncoding === target && content === observed.content) {
        plan.recode.unchanged.push(observed.path)
        continue
      }
      plan.baseRevisions[observed.path] = observed.revision
      const initial = { path: observed.path, revision: observed.revision, content: observed.content, coverage: completeProjectCoverage(observed.content) }
      const view = { ...initial, content, coverage: completeProjectCoverage(content) }
      plan.paths.set(observed.path, { view, initial, created: false, deleted: false, generation: 1, history: [{ content }] })
      plan.operations.push({ operation: { type: 'replace_content', path: observed.path, expectedContent: observed.content, content, mode: 'recode', targetEncoding: target } })
      plan.recode.converted.push({ path: observed.path, from: describeTextFormat(observed.textEncoding, observed.content), to: describeTextFormat(target, content) })
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, pathIndex }, error.suggestedNextAction)
    }
  }
}

/** 给要移走或删除的文件排一条只读守卫：提交时它的正文必须还是计划看到的样子。 */
function guardPlanFile(plan: ProjectFilePlanState, identity: FileIdentity): void {
  plan.operations.push({ operation: { type: 'replace_content', path: identity.view.path, expectedContent: identity.view.content, content: identity.view.content, mode: 'guard' } })
}

/** 核对 create、move 的目标路径不存在（计划里也没被占），记下它的 revision，返回规范化后的路径。 */
async function planDestination(plan: ProjectFilePlanState, path: string): Promise<string> {
  const observed = await plan.resolver.readPath(path)
  const staged = plan.paths.get(observed.path)
  if (staged || (isUndefined(staged) && observed.exists)) {
    throw new ProjectError('TARGET_EXISTS', `目标路径已存在：${observed.path}。`, { path: observed.path }, 'create 与 move 不覆盖已有文件：换一个不存在的路径；确实要整体替换，先读取该文件获取 fileRef，再用 overwrite。')
  }
  if (isUndefined(staged)) plan.baseRevisions[observed.path] = observed.revision
  return observed.path
}

/** 解析一个文件来源（fileRef、sourceRef，或本计划创建的 path），返回它在计划里的身份与当前视图。 */
async function planSource(plan: ProjectFilePlanState, selector: ProjectStepSource): Promise<SourceSelection> {
  const supplied = ['fileRef', 'sourceRef', 'path'].filter((key) => key in selector)
  if (supplied.length !== 1) throw new ProjectError('INVALID_INPUT', '仅填写 fileRef、sourceRef、path 之一。')
  if ('path' in selector) {
    const observed = await plan.resolver.readPath(selector.path)
    const identity = plan.paths.get(observed.path)
    if (!identity?.created || identity.deleted) {
      throw new ProjectError('TARGET_NOT_FOUND', `path 只指本次前面的步骤 create 出来、还在的文件，${observed.path} 不是。`, { path: observed.path },
        '已有的文件用 read 或 search 给的 fileRef 指；被本次前面的步骤移动或改过的，用 sourceRef 填同一个原 fileRef。')
    }
    return { identity, view: identity.view }
  }
  const follows = 'sourceRef' in selector
  const reference = follows ? selector.sourceRef : selector.fileRef
  let binding = plan.references.get(reference)
  if (!binding) {
    const view = await plan.resolver.resolveFileRef(reference)
    // sourceRef 跟随原文件身份，即使另一文件已经占据原路径。
    const originalIdentity = follows ? [...plan.references.values()].find((entry) =>
      entry.identity.initial.path === view.path && entry.identity.initial.revision === view.revision && entry.identity.initial.content === view.content
    )?.identity : undefined
    const knownIdentity = plan.paths.get(view.path)
    let identity = toOptional(originalIdentity ?? knownIdentity)
    if (plan.paths.has(view.path) && !identity) throw new ProjectError('TARGET_NOT_FOUND', '引用的文件已在本计划删除或移走。', { path: view.path })
    if (identity) {
      if (identity.initial.revision !== view.revision || identity.initial.content !== view.content) throw new ProjectError('BASE_REVISION_MISMATCH', '同文件的引用版本不一致。', { path: view.path })
    } else {
      identity = { view, initial: view, created: false, deleted: false, generation: 0, history: [] }
      plan.paths.set(view.path, identity)
      plan.baseRevisions[view.path] = view.revision
    }
    let projected = view
    for (const step of identity.history) projected = { ...projected, content: step.content, coverage: step.mutations
      ? advanceProjectCoverage(projected, step.content, step.mutations)
      : completeProjectCoverage(step.content) }
    binding = { identity, view: { ...projected, path: identity.view.path } }
    plan.references.set(reference, binding)
  }
  const { identity } = binding
  if (identity.deleted) throw new ProjectError('TARGET_NOT_FOUND', '引用文件已在本计划删除。')
  if (!follows && identity.generation > 0) throw new ProjectError('INVALID_INPUT',
    `这一步引用的文件已被本计划前面的步骤移动或修改（现在是 ${identity.view.path}）。`,
    { path: identity.view.path },
    '同一个文件的几处编辑合并到同一步的 edits 里；确实要分成几步就把这一项的键名 fileRef 改成 sourceRef，值不变，range 按前面步骤改完后的内容算，拿不准就用 match。')
  return binding
}

/** 执行一个文件动作（create、overwrite、move、delete、recode），推进计划里的文件视图。 */
async function planFileAction(plan: ProjectFilePlanState, action: ProjectPlanFileAction): Promise<void> {
  if (action.op === 'recode') {
    await recodePlanFiles(plan, action)
    return
  }
  if (action.op === 'create') {
    const text = normalizeProjectInputText(action.text)
    const path = await planDestination(plan, action.path)
    const view = { path, content: text, revision: `plan:${plan.operations.length}`, coverage: completeProjectCoverage(text) }
    plan.paths.set(path, { view, initial: view, created: true, deleted: false, generation: 0, history: [] })
    plan.operations.push({ operation: { type: 'create_file', path, content: text } })
    return
  }
  const { identity, view } = await planSource(plan, action)
  switch (action.op) {
    case 'overwrite': {
      // 整份替换会把没看过的行一起丢掉，所以要求 fileRef 覆盖全文；move、delete 不动正文，只核对版本。
      if (!coversWholeProjectFile(view))
        throw new ProjectError('SCOPE_VIOLATION', `${view.path} 只看过其中一段，不能整份替换。`, { path: view.path },
          '整份替换前先 read 整个文件（不给 range 就是从头读，读不完就用 continuation 接着读），拿覆盖整个文件的 fileRef 再 overwrite；只改其中几处用 edit 步骤。')
      const source = createProjectSourceCoordinates(view.content)
      const text = normalizePhysicalNewlines(normalizeProjectInputText(action.text), sourceNewlineAt(source, 0, view.content.length))
      plan.operations.push({ operation: { type: 'replace_content', path: view.path, expectedContent: view.content, content: text, mode: 'overwrite' } })
      identity.view = { ...view, content: text, coverage: completeProjectCoverage(text) }
      identity.history.push({ content: text })
      for (const binding of plan.references.values()) if (binding.identity === identity) binding.view = { ...identity.view }
      break
    }
    case 'move': {
      const to = await planDestination(plan, action.to)
      guardPlanFile(plan, identity)
      plan.operations.push({ operation: { type: 'rename_file', from: view.path, to } })
      plan.paths.set(view.path, null)
      plan.paths.set(to, identity)
      identity.view = { ...view, path: to }
      for (const binding of plan.references.values()) if (binding.identity === identity) binding.view = { ...binding.view, path: to }
      break
    }
    case 'delete':
      guardPlanFile(plan, identity)
      plan.operations.push({ operation: { type: 'delete_file', path: view.path } })
      plan.paths.set(view.path, null)
      identity.deleted = true
      break
    default:
      throw new ProjectError('INVALID_INPUT', '文件动作仅支持 create、overwrite、move、delete、recode。')
  }
  identity.generation += 1
}

/** 执行一步 edit：一步就是一个文件，先把这个文件的几处编辑全部定位、验证完，再推进计划里的文件视图。 */
async function planEditStep(plan: ProjectFilePlanState, file: ProjectStepSource & { edits: readonly ProjectContentEdit[] }): Promise<void> {
  const { identity, view } = await planSource(plan, file)
  const mutations = selectProjectMutations(view, file.edits)
  const content = applyProjectMutations(view, mutations)
  plan.operations.push({ operation: { type: 'replace_content', path: view.path, expectedContent: view.content, content, mode: 'edit' } })
  identity.view = { ...view, content, coverage: advanceProjectCoverage(view, content, mutations) }
  identity.history.push({ content, mutations })
  for (const binding of plan.references.values()) if (binding.identity === identity) binding.view = {
    ...binding.view, content, coverage: advanceProjectCoverage(binding.view, content, mutations),
  }
  identity.generation += 1
}

/** 把一步文件动作翻成计划内部那套形状：字段一样，只是判别键从 action 换成 op。 */
function stepFileAction(step: Exclude<ProjectEditStep, { action: 'edit' }>): ProjectPlanFileAction {
  const { action, ...rest } = step
  return { op: action, ...rest } as ProjectPlanFileAction
}

/** 把计划收成 prepareEdit 的输入；metadata 记下来源，有 recode 时带上回执。 */
function planResult(plan: ProjectFilePlanState): PrepareEditInput {
  const metadata: Record<string, unknown> = { source: 'velar:project' }
  if (!isEmpty(plan.recode.converted) || !isEmpty(plan.recode.unchanged)) metadata.recode = plan.recode
  return { operations: plan.operations, baseRevisions: plan.baseRevisions, metadata }
}

/** 把 edit 的有序步骤编译成一个事务输入：后面的步骤可以用 sourceRef、path 跟随前面步骤的结果，出错时补上 stepIndex。 */
export async function compileProjectEdit(input: ProjectEditInput, resolver: ProjectPlannerResolver): Promise<PrepareEditInput> {
  if (isEmpty(input.steps) || input.steps.length > ProjectFileLimits.steps) throw new ProjectError('INVALID_INPUT', `edit 要 1–${ProjectFileLimits.steps} 个有序步骤。`)
  const plan = createFilePlan(resolver)
  for (const [stepIndex, step] of input.steps.entries()) {
    try {
      if (step.action === 'edit') await planEditStep(plan, step)
      else await planFileAction(plan, stepFileAction(step))
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, stepIndex }, error.suggestedNextAction)
    }
  }
  return planResult(plan)
}
