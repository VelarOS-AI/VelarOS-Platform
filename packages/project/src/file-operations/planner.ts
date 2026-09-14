import { isEmpty, isUndefined, toOptional } from '@velaros-ai/core'

import { applyProjectMutations } from '../editing/planner/content.js'
import { advanceProjectCoverage, completeProjectCoverage } from '../editing/planner/coverage.js'
import { type ProjectResolvedMutation, selectProjectMutations } from '../editing/selectors/select.js'
import { normalizePhysicalNewlines, ProjectSourceCoordinates } from '../editing/selectors/source.js'
import type { ProjectChangeApplyInput, ProjectContentEdit, ProjectEditView, ProjectFileInput, ProjectPlanFileAction, ProjectPlannerResolver, ProjectPlanSource, ProjectRecodeAction, ProjectRecodeNewline } from '../editing/types.js'
import { ProjectError } from '../errors.js'
import type { PrepareEditInput } from '../types/edit.js'
import type { ProjectTextEncoding } from '../types/text.js'
import { normalizeProjectInputText } from '../utils/text.js'

interface FileIdentity {
  view: ProjectEditView
  initial: ProjectEditView
  created: boolean
  deleted: boolean
  generation: number
  history: Array<{ content: string; mutations?: readonly ProjectResolvedMutation[] }>
}

interface SourceSelection { identity: FileIdentity; view: ProjectEditView }

/** 回执只报告模型可读的格式名；转换本身由事务字节计划按目标编码重写。 */
export interface ProjectRecodeReceipt {
  converted: Array<{ path: string; from: string; to: string }>
  unchanged: string[]
}

function recodeTargetEncoding(action: ProjectRecodeAction): ProjectTextEncoding {
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

function convertNewlines(content: string, newline?: ProjectRecodeNewline): string {
  if (!newline) return content
  const lf = content.replace(/\r\n/gu, '\n')
  return newline === 'lf' ? lf : lf.replace(/\n/gu, '\r\n')
}

function describeTextFormat(encoding: ProjectTextEncoding, content: string): string {
  const label = encoding === 'gb18030' ? 'gb18030'
    : encoding.startsWith('utf16le') ? 'utf-16le'
      : encoding.startsWith('utf16be') ? 'utf-16be' : 'utf-8'
  const bom = encoding === 'utf8-bom' || encoding === 'utf16le' || encoding === 'utf16be'
  const crlf = content.includes('\r\n')
  const lf = /(?:^|[^\r])\n/u.test(content)
  const newline = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none'
  return `${label}${bom ? '+bom' : ''} ${newline}`
}

/** 文件动作与混合计划的有序未来视图，只生成计划。 */
class ProjectFilePlan {
  private readonly paths = new Map<string, Nullable<FileIdentity>>()
  private readonly references = new Map<string, SourceSelection>()
  private readonly operations: PrepareEditInput['operations'] = []
  private readonly baseRevisions: Record<string, string> = {}
  private readonly recode: ProjectRecodeReceipt = { converted: [], unchanged: [] }

  constructor(private readonly resolver: ProjectPlannerResolver) {}

  /** 按路径批量转换磁盘编码；正文不变的文件跳过，已在本计划改动的文件拒绝，避免两套坐标叠加。 */
  private async recodeFiles(action: ProjectRecodeAction): Promise<void> {
    const target = recodeTargetEncoding(action)
    const seen = new Set<string>()
    for (const [pathIndex, raw] of action.paths.entries()) {
      try {
        const observed = await this.resolver.readText(raw)
        if (seen.has(observed.path)) continue
        seen.add(observed.path)
        if (this.paths.has(observed.path))
          throw new ProjectError('INVALID_INPUT', '本计划已改动的文件不能再转换编码；请先提交前面的改动。', { path: observed.path })
        const content = convertNewlines(observed.content, action.newline)
        if (observed.textEncoding === target && content === observed.content) {
          this.recode.unchanged.push(observed.path)
          continue
        }
        this.baseRevisions[observed.path] = observed.revision
        const initial = { path: observed.path, revision: observed.revision, content: observed.content, coverage: completeProjectCoverage(observed.content) }
        const view = { ...initial, content, coverage: completeProjectCoverage(content) }
        this.paths.set(observed.path, { view, initial, created: false, deleted: false, generation: 1, history: [{ content }] })
        this.operations.push({ operation: { type: 'replace_content', path: observed.path, expectedContent: observed.content, content, mode: 'recode', targetEncoding: target } })
        this.recode.converted.push({ path: observed.path, from: describeTextFormat(observed.textEncoding, observed.content), to: describeTextFormat(target, content) })
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error
        throw new ProjectError(error.reason, error.message, { ...error.details, pathIndex }, error.suggestedNextAction)
      }
    }
  }

  private guard(identity: FileIdentity): void {
    this.operations.push({ operation: { type: 'replace_content', path: identity.view.path, expectedContent: identity.view.content, content: identity.view.content, mode: 'guard' } })
  }

  private async destination(path: string): Promise<string> {
    const observed = await this.resolver.readPath(path)
    const staged = this.paths.get(observed.path)
    if (staged || (isUndefined(staged) && observed.exists)) {
      throw new ProjectError('CONFLICT_WITH_EXTERNAL_EDIT', '目标文件已存在。', { path: observed.path }, '请选择不存在的路径；明确覆盖现有文件请使用 overwrite。')
    }
    if (isUndefined(staged)) this.baseRevisions[observed.path] = observed.revision
    return observed.path
  }

  private async source(selector: ProjectPlanSource, allowFuture: boolean): Promise<SourceSelection> {
    const supplied = ['fileRef', 'sourceRef', 'path'].filter((key) => key in selector)
    if (supplied.length !== 1) throw new ProjectError('INVALID_INPUT', '仅填写 fileRef、sourceRef、path 之一。')
    if ('path' in selector) {
      if (!allowFuture) throw new ProjectError('INVALID_INPUT', 'file 工具使用 fileRef；计划内路径引用由 change 提供。')
      const observed = await this.resolver.readPath(selector.path)
      const identity = this.paths.get(observed.path)
      if (!identity?.created || identity.deleted) throw new ProjectError('TARGET_NOT_FOUND', 'path 只能引用本计划创建且仍存在的文件。', { path: observed.path })
      return { identity, view: identity.view }
    }
    const follows = 'sourceRef' in selector
    if (follows && !allowFuture) throw new ProjectError('INVALID_INPUT', 'sourceRef 仅用于 change 计划。')
    const reference = follows ? selector.sourceRef : selector.fileRef
    let binding = this.references.get(reference)
    if (!binding) {
      const view = await this.resolver.resolveFileRef(reference)
      // sourceRef 跟随原文件身份，即使另一文件已经占据原路径。
      const originalIdentity = follows ? [...this.references.values()].find((entry) =>
        entry.identity.initial.path === view.path && entry.identity.initial.revision === view.revision && entry.identity.initial.content === view.content
      )?.identity : undefined
      const knownIdentity = this.paths.get(view.path)
      let identity = toOptional(originalIdentity ?? knownIdentity)
      if (this.paths.has(view.path) && !identity) throw new ProjectError('TARGET_NOT_FOUND', '引用的文件已在本计划删除或移走。', { path: view.path })
      if (identity) {
        if (identity.initial.revision !== view.revision || identity.initial.content !== view.content) throw new ProjectError('BASE_REVISION_MISMATCH', '同文件的引用版本不一致。', { path: view.path })
      } else {
        identity = { view, initial: view, created: false, deleted: false, generation: 0, history: [] }
        this.paths.set(view.path, identity)
        this.baseRevisions[view.path] = view.revision
      }
      let projected = view
      for (const step of identity.history) projected = { ...projected, content: step.content, coverage: step.mutations
        ? advanceProjectCoverage(projected, step.content, step.mutations)
        : completeProjectCoverage(step.content) }
      binding = { identity, view: { ...projected, path: identity.view.path } }
      this.references.set(reference, binding)
    }
    const { identity } = binding
    if (identity.deleted) throw new ProjectError('TARGET_NOT_FOUND', '引用文件已在本计划删除。')
    if (!follows && identity.generation > 0) throw new ProjectError('BASE_REVISION_MISMATCH', 'fileRef 的原始视图已经被前序计划步骤修改。', { path: identity.view.path }, '后续步骤使用 sourceRef 跟随当前计划中的文件身份。')
    return binding
  }

  public async file(action: ProjectPlanFileAction, allowFuture: boolean): Promise<void> {
    if (action.op === 'recode') {
      await this.recodeFiles(action)
      return
    }
    if (action.op === 'create') {
      const text = normalizeProjectInputText(action.text)
      const path = await this.destination(action.path)
      const view = { path, content: text, revision: `plan:${this.operations.length}`, coverage: completeProjectCoverage(text) }
      this.paths.set(path, { view, initial: view, created: true, deleted: false, generation: 0, history: [] })
      this.operations.push({ operation: { type: 'create_file', path, content: text } })
      return
    }
    const { identity, view } = await this.source(action, allowFuture)
    switch (action.op) {
      case 'overwrite': {
        const source = new ProjectSourceCoordinates(view.content)
        const text = normalizePhysicalNewlines(normalizeProjectInputText(action.text), source.newlineAt(0, view.content.length))
        this.operations.push({ operation: { type: 'replace_content', path: view.path, expectedContent: view.content, content: text, mode: 'overwrite' } })
        identity.view = { ...view, content: text, coverage: completeProjectCoverage(text) }
        identity.history.push({ content: text })
        for (const binding of this.references.values()) if (binding.identity === identity) binding.view = { ...identity.view }
        break
      }
      case 'move': {
        const to = await this.destination(action.to)
        this.guard(identity)
        this.operations.push({ operation: { type: 'rename_file', from: view.path, to } })
        this.paths.set(view.path, null)
        this.paths.set(to, identity)
        identity.view = { ...view, path: to }
        for (const binding of this.references.values()) if (binding.identity === identity) binding.view = { ...binding.view, path: to }
        break
      }
      case 'delete':
        this.guard(identity)
        this.operations.push({ operation: { type: 'delete_file', path: view.path } })
        this.paths.set(view.path, null)
        identity.deleted = true
        break
      default:
        throw new ProjectError('INVALID_INPUT', '文件动作仅支持 create、overwrite、move、delete、recode。')
    }
    identity.generation += 1
  }

  public async edit(files: ReadonlyArray<ProjectPlanSource & { edits: readonly ProjectContentEdit[] }>): Promise<void> {
    const groups = new Map<FileIdentity, { view: ProjectEditView; mutations: ProjectResolvedMutation[] }>()
    for (const [fileIndex, file] of files.entries()) {
      try {
        const { identity, view } = await this.source(file, true)
        const mutations = selectProjectMutations(view, file.edits).map((mutation) => ({ ...mutation, fileIndex }))
        const previous = groups.get(identity)
        if (previous) previous.mutations.push(...mutations)
        else groups.set(identity, { view, mutations })
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error
        throw new ProjectError(error.reason, error.message, { ...error.details, fileIndex }, error.suggestedNextAction)
      }
    }
    // 所有分组先完成定位与验证，再推进计划中的文件视图。
    const ready = [...groups].map(([identity, group]) => ({ identity, ...group, content: applyProjectMutations(group.view, group.mutations) }))
    for (const { identity, view, content, mutations } of ready) {
      this.operations.push({ operation: { type: 'replace_content', path: view.path, expectedContent: view.content, content, mode: 'edit' } })
      identity.view = { ...view, content, coverage: advanceProjectCoverage(view, content, mutations) }
      identity.history.push({ content, mutations })
      for (const binding of this.references.values()) if (binding.identity === identity) binding.view = {
        ...binding.view, content, coverage: advanceProjectCoverage(binding.view, content, mutations),
      }
      identity.generation += 1
    }
  }

  public result(tool: string): PrepareEditInput {
    const metadata: Record<string, unknown> = { projectContract: 2, tool }
    if (!isEmpty(this.recode.converted) || !isEmpty(this.recode.unchanged)) metadata.recode = this.recode
    return { operations: this.operations, baseRevisions: this.baseRevisions, metadata }
  }
}

export async function compileProjectFile(input: ProjectFileInput, resolver: ProjectPlannerResolver): Promise<PrepareEditInput> {
  if (isEmpty(input.actions) || input.actions.length > 1000) throw new ProjectError('INVALID_INPUT', 'actions 需要 1–1000 个文件动作。')
  const plan = new ProjectFilePlan(resolver)
  for (const [actionIndex, action] of input.actions.entries()) {
    try { await plan.file(action, false) } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, actionIndex }, error.suggestedNextAction)
    }
  }
  return plan.result('project:file')
}

export async function compileProjectChange(input: ProjectChangeApplyInput, resolver: ProjectPlannerResolver): Promise<PrepareEditInput> {
  if (input.action !== 'apply' || isEmpty(input.steps) || input.steps.length > 1000) throw new ProjectError('INVALID_INPUT', 'apply 需要 1–1000 个有序步骤。')
  const plan = new ProjectFilePlan(resolver)
  for (const [stepIndex, step] of input.steps.entries()) {
    try {
      if (step.tool === 'edit') await plan.edit(step.files)
      else if (step.tool === 'file') {
        for (const [actionIndex, action] of step.actions.entries()) {
          try { await plan.file(action, true) } catch (error) {
            if (!(error instanceof ProjectError)) throw error
            throw new ProjectError(error.reason, error.message, { ...error.details, actionIndex }, error.suggestedNextAction)
          }
        }
      } else throw new ProjectError('INVALID_INPUT', '计划步骤仅支持 file 或 edit。')
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, stepIndex }, error.suggestedNextAction)
    }
  }
  return plan.result('project:change')
}
