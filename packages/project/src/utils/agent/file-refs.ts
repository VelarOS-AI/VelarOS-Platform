import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { type FileContextCarrier,fileContextFor } from '@velaros-ai/agent/tool-contract'
import { isObject } from '@velaros-ai/core'

import type { ProjectToolApi } from '../../contract/requires.js'
import { ProjectError } from '../errors.js'

export interface ProjectReferenceContext extends FileContextCarrier {
  project: Pick<ProjectToolApi, 'getRootPath' | 'kernel'>
  fileRefScopeId?: string
}

export interface ProjectVisibleCoverage {
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
  completeLines: boolean
}

export interface ProjectFileView {
  path: string
  revision: string
  contentRevision: string
  content: string
  coverage: ProjectVisibleCoverage[]
}

interface SourceRecord {
  kind: 'project-file-source'
  version: 1
  workspace: string
  scope: string
  path: string
  revision: string
  contentRevision: string
  content: string
}
interface ViewRecord {
  kind: 'project-file-view'
  version: 1
  source: string
  scope: string
  coverage: ProjectVisibleCoverage[]
}
interface PageRecord {
  kind: 'project-read-page'
  version: 1
  source: string
  scope: string
  range: { startLine: number; startColumn?: number; endLine?: number; endColumn?: number }
}
type RefRecord = SourceRecord | ViewRecord | PageRecord
const RefTool = '__project_file_reference__'
const fallbackStores = new WeakMap<object, Map<string, RefRecord>>()
const fallbackScopes = new WeakMap<object, string>()

function owner(context: ProjectReferenceContext): object {
  const candidate = context.fileContextScope ?? context.codingSession
  return candidate && isObject(candidate) ? candidate : context.project
}

export function projectFileRefScope(context: ProjectReferenceContext): string {
  if (context.fileRefScopeId) return context.fileRefScopeId
  const coordinator = fileContextFor(context)
  if (coordinator) return coordinator.scopeId
  const key = owner(context)
  let scope = fallbackScopes.get(key)
  if (!scope) fallbackScopes.set(key, (scope = randomUUID()))
  return scope
}

export function projectContentRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function put(context: ProjectReferenceContext, value: RefRecord, prefix: string): Promise<string> {
  const serializedResult = JSON.stringify(value)
  const hash = projectContentRevision(serializedResult)
  if (context.contextPayloadStore && context.sessionId) {
    await context.contextPayloadStore.put({
      sessionId: context.sessionId,
      hash,
      payloadRef: `ctx-payload:${encodeURIComponent(context.sessionId)}:${hash}`,
      toolCallId: `${prefix}${hash}`,
      toolName: RefTool,
      serializedResult,
      chars: serializedResult.length,
      createdAt: Date.now(),
    })
  } else {
    const key = owner(context)
    let records = fallbackStores.get(key)
    if (!records) fallbackStores.set(key, (records = new Map()))
    records.set(hash, value)
  }
  return `${prefix}${hash}`
}

/** 引用不可用时的下一步：模型只能原样复制框架签发的引用，缺引用就去读，不能自己拼。 */
const ReadForReferenceNextAction =
  '引用只能原样复制 [Current project files] 或读取结果里的值；当前视图没有该文件时，先用 project:read 读取目标范围获取 fileRef。失败回执带 inputReuse 时，用 reuse + changes 只替换引用字段，正文保持原样。'

async function get(context: ProjectReferenceContext, ref: string): Promise<RefRecord> {
  if (!/^(?:source|view|read-page):[a-f0-9]{64}$/.test(ref))
    throw new ProjectError('INVALID_INPUT', `引用 ${JSON.stringify(ref.slice(0, 80))} 不是框架签发的值（view:… / read-page:… 加 64 位十六进制），不能手写或改写。`, { ref: ref.slice(0, 80) }, ReadForReferenceNextAction)
  const hash = ref.slice(ref.indexOf(':') + 1)
  let value: RefRecord | undefined
  if (context.contextPayloadStore && context.sessionId) {
    const record = await context.contextPayloadStore.findByHash(context.sessionId, hash)
    if (record?.toolName === RefTool && projectContentRevision(record.serializedResult) === hash)
      value = JSON.parse(record.serializedResult) as RefRecord
  } else value = fallbackStores.get(owner(context))?.get(hash)
  if (!value || value.version !== 1 || value.scope !== projectFileRefScope(context))
    throw new ProjectError('INVALID_INPUT', '该引用不属于当前会话或执行分支（可能来自别的会话，或所在分支已回退）。', { ref }, ReadForReferenceNextAction)
  if (value.kind === 'project-file-source' && value.workspace !== resolve(context.project.getRootPath()))
    throw new ProjectError('INVALID_INPUT', '该引用属于另一个工作区。', { ref }, ReadForReferenceNextAction)
  return value
}

/** Candidate snapshots contain no editing grant. Only final model presentation can issue a view. */
export async function saveProjectFileSource(
  context: ProjectReferenceContext,
  input: { path: string; revision: string; content: string }
): Promise<string> {
  return put(context, {
    kind: 'project-file-source', version: 1,
    workspace: resolve(context.project.getRootPath()),
    scope: projectFileRefScope(context), ...input,
    contentRevision: projectContentRevision(input.content),
  }, 'source:')
}

export async function resolveProjectFileSource(context: ProjectReferenceContext, ref: string): Promise<SourceRecord> {
  const record = await get(context, ref)
  if (record.kind === 'project-file-source') return record
  if (record.kind === 'project-file-view' || record.kind === 'project-read-page')
    return resolveProjectFileSource(context, record.source)
  throw new ProjectError('INVALID_INPUT', 'Invalid source reference.')
}

export async function saveProjectFileRef(
  context: ProjectReferenceContext,
  source: string,
  coverage: ProjectVisibleCoverage[]
): Promise<string> {
  const record = await resolveProjectFileSource(context, source)
  const sourceRef = source.startsWith('source:') ? source : await saveProjectFileSource(context, record)
  return put(context, {
    kind: 'project-file-view', version: 1, source: sourceRef,
    scope: projectFileRefScope(context), coverage,
  }, 'view:')
}

/** Historical view access remains subject to today's authorization and redaction policy. */
export async function loadProjectFileView(context: ProjectReferenceContext, fileRef: string): Promise<ProjectFileView> {
  const record = await get(context, fileRef)
  if (record.kind !== 'project-file-view' || !fileRef.startsWith('view:'))
    throw new ProjectError('INVALID_INPUT', '这不是可编辑的 fileRef：编辑只接受当前视图或读取结果里的 view:… 引用。', { ref: fileRef }, ReadForReferenceNextAction)
  const source = await resolveProjectFileSource(context, record.source)
  const kernel = await context.project.kernel()
  if (!kernel.prepareContextSnapshot) throw new ProjectError('INVALID_INPUT', 'Historical snapshot authorization is unavailable.')
  const authorized = await kernel.prepareContextSnapshot({ path: source.path, content: source.content })
  if (authorized.redacted || authorized.content !== source.content)
    throw new ProjectError('PERMISSION_DENIED', '当前项目策略限制了该引用对应的源码，不能用它编辑。', { path: source.path })
  return { path: source.path, revision: source.revision, contentRevision: source.contentRevision, content: source.content, coverage: structuredClone(record.coverage) }
}

/**
 * 读取不可变原文并按正文复核当前文件。正文未变就沿用当前 revision：元数据型 revision 策略下只动 mtime
 * 不算过期，计划也以当前版本为基准提交；正文变了才按过期拒绝，由编辑恢复链给出新位置候选。
 */
export async function resolveProjectFileRef(context: ProjectReferenceContext, fileRef: string): Promise<ProjectFileView> {
  const source = await loadProjectFileView(context, fileRef)
  const kernel = await context.project.kernel()
  const current = await kernel.read({ path: source.path, maxChars: Math.max(source.content.length + 1, 1) })
  if (current.redacted || current.truncated || current.hasMore || current.content !== source.content || !current.snapshot.revision)
    throw new ProjectError('BASE_REVISION_MISMATCH', `${source.path} 在该 fileRef 显示之后已被修改。`,
      { path: source.path, expected: source.revision, actual: current.snapshot.revision },
      '用 project:read 重新读取目标范围获取新 fileRef；失败回执带 inputReuse 时，用 reuse + changes 只替换 fileRef（有 range 的编辑同时确认新行号），正文保持原样。')
  return { ...source, revision: current.snapshot.revision }
}

export async function saveProjectReadPage(
  context: ProjectReferenceContext,
  source: string,
  range: PageRecord['range']
): Promise<string> {
  await resolveProjectFileSource(context, source)
  return put(context, { kind: 'project-read-page', version: 1, source, scope: projectFileRefScope(context), range }, 'read-page:')
}

export async function resolveProjectReadPage(context: ProjectReferenceContext, ref: string) {
  const page = await get(context, ref)
  if (page.kind !== 'project-read-page') throw new ProjectError('INVALID_INPUT', 'Invalid read continuation.')
  const source = await resolveProjectFileSource(context, page.source)
  return { path: source.path, revision: source.revision, content: source.content, range: page.range, source: page.source }
}
