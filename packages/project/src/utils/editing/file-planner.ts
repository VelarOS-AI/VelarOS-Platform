// 域：project:file 与 project:change 的编译。计划是一份按步骤推进的「未来视图」：每个路径在计划里的文件身份、
// fileRef / sourceRef 绑定到的身份，以及排好的事务操作。只生成计划，不读写磁盘，读取都经过 resolver。
import { isEmpty, isUndefined, toOptional } from '@velaros-ai/core'
import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import { ProjectChangeLimits } from '../../contract/constants.js'
import type { PrepareEditInput } from '../../types/edit.js'
import type { FileIdentity, ProjectChangeApplyInput, ProjectChangeStep, ProjectContentEdit, ProjectFileInput, ProjectFilePlanState, ProjectPlanFileAction, ProjectPlannerResolver, ProjectPlanSource, ProjectRecodeAction, ProjectRecodeNewline, SourceSelection } from '../../types/editing.js'
import { ProjectError } from '../errors.js'
import { normalizeProjectInputText } from '../text.js'

import { applyProjectMutations } from './content-planner.js'
import { advanceProjectCoverage, completeProjectCoverage } from './planner-coverage.js'
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

/** 按路径批量转换磁盘编码；正文不变的文件跳过，已在本计划改动的文件拒绝，避免两套坐标叠加。 */
async function recodePlanFiles(plan: ProjectFilePlanState, action: ProjectRecodeAction): Promise<void> {
  const target = recodeTargetEncoding(action)
  const seen = new Set<string>()
  for (const [pathIndex, raw] of action.paths.entries()) {
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
async function planSource(plan: ProjectFilePlanState, selector: ProjectPlanSource, allowFuture: boolean): Promise<SourceSelection> {
  const supplied = ['fileRef', 'sourceRef', 'path'].filter((key) => key in selector)
  if (supplied.length !== 1) throw new ProjectError('INVALID_INPUT', '仅填写 fileRef、sourceRef、path 之一。')
  if ('path' in selector) {
    if (!allowFuture) throw new ProjectError('INVALID_INPUT', 'file 工具使用 fileRef；计划内路径引用由 change 提供。')
    const observed = await plan.resolver.readPath(selector.path)
    const identity = plan.paths.get(observed.path)
    if (!identity?.created || identity.deleted) throw new ProjectError('TARGET_NOT_FOUND', 'path 只能引用本计划创建且仍存在的文件。', { path: observed.path })
    return { identity, view: identity.view }
  }
  const follows = 'sourceRef' in selector
  if (follows && !allowFuture) throw new ProjectError('INVALID_INPUT', 'sourceRef 仅用于 change 计划。')
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
    '把这一项的键名 fileRef 改成 sourceRef，值不变；range 按前面步骤改完后的内容算，拿不准就用 match。')
  return binding
}

/** 执行一个文件动作（create、overwrite、move、delete、recode），推进计划里的文件视图。 */
async function planFileAction(plan: ProjectFilePlanState, action: ProjectPlanFileAction, allowFuture: boolean): Promise<void> {
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
  const { identity, view } = await planSource(plan, action, allowFuture)
  switch (action.op) {
    case 'overwrite': {
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
async function planEditStep(plan: ProjectFilePlanState, file: ProjectPlanSource & { edits: readonly ProjectContentEdit[] }): Promise<void> {
  const { identity, view } = await planSource(plan, file, true)
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

/** 把一步文件动作翻回 project:file 那套形状：字段一样，只是判别键从 action 换回 op。 */
function stepFileAction(step: Exclude<ProjectChangeStep, { action: 'edit' }>): ProjectPlanFileAction {
  const { action, ...rest } = step
  return { op: action, ...rest } as ProjectPlanFileAction
}

/** 把计划收成 prepareEdit 的输入；metadata 记下契约版本、工具名，有 recode 时带上回执。 */
function planResult(plan: ProjectFilePlanState, tool: string): PrepareEditInput {
  const metadata: Record<string, unknown> = { projectContract: 2, tool }
  if (!isEmpty(plan.recode.converted) || !isEmpty(plan.recode.unchanged)) metadata.recode = plan.recode
  return { operations: plan.operations, baseRevisions: plan.baseRevisions, metadata }
}

/** 把 project:file 编译成事务输入：按顺序执行文件动作，出错时在错误里补上 actionIndex。 */
export async function compileProjectFile(input: ProjectFileInput, resolver: ProjectPlannerResolver): Promise<PrepareEditInput> {
  if (isEmpty(input.actions) || input.actions.length > ProjectChangeLimits.fileActions) throw new ProjectError('INVALID_INPUT', `actions 需要 1–${ProjectChangeLimits.fileActions} 个文件动作。`)
  const plan = createFilePlan(resolver)
  for (const [actionIndex, action] of input.actions.entries()) {
    try { await planFileAction(plan, action, false) } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, actionIndex }, error.suggestedNextAction)
    }
  }
  return planResult(plan, 'project:file')
}

/** 把 project:change 的有序步骤编译成一个事务输入：后面的步骤可以用 sourceRef、path 跟随前面步骤的结果，出错时补上 stepIndex。 */
export async function compileProjectChange(input: ProjectChangeApplyInput, resolver: ProjectPlannerResolver): Promise<PrepareEditInput> {
  if (input.action !== 'apply' || isEmpty(input.steps) || input.steps.length > ProjectChangeLimits.steps) throw new ProjectError('INVALID_INPUT', `apply 需要 1–${ProjectChangeLimits.steps} 个有序步骤。`)
  const plan = createFilePlan(resolver)
  for (const [stepIndex, step] of input.steps.entries()) {
    try {
      if (step.action === 'edit') await planEditStep(plan, step)
      else await planFileAction(plan, stepFileAction(step), true)
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, stepIndex }, error.suggestedNextAction)
    }
  }
  return planResult(plan, 'project:change')
}
