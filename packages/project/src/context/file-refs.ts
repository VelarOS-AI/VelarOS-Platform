import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { type FileContextCarrier,fileContextFor } from '@velaros-ai/agent/tool-contract'
import { isObject } from '@velaros-ai/core'

import type { ProjectToolApi } from '../agent/Types.js'
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

async function get(context: ProjectReferenceContext, ref: string): Promise<RefRecord> {
  if (!/^(?:source|view|read-page):[a-f0-9]{64}$/.test(ref))
    throw new ProjectError('INVALID_INPUT', 'Use a fileRef or continuation returned by project:read.')
  const hash = ref.slice(ref.indexOf(':') + 1)
  let value: RefRecord | undefined
  if (context.contextPayloadStore && context.sessionId) {
    const record = await context.contextPayloadStore.findByHash(context.sessionId, hash)
    if (record?.toolName === RefTool && projectContentRevision(record.serializedResult) === hash)
      value = JSON.parse(record.serializedResult) as RefRecord
  } else value = fallbackStores.get(owner(context))?.get(hash)
  if (!value || value.version !== 1 || value.scope !== projectFileRefScope(context))
    throw new ProjectError('INVALID_INPUT', 'File reference is unavailable in this execution branch; read the file again.')
  if (value.kind === 'project-file-source' && value.workspace !== resolve(context.project.getRootPath()))
    throw new ProjectError('INVALID_INPUT', 'File reference belongs to another workspace.')
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
    throw new ProjectError('INVALID_INPUT', 'This is a source candidate, not an editable fileRef. Read the file first.')
  const source = await resolveProjectFileSource(context, record.source)
  const kernel = await context.project.kernel()
  if (!kernel.prepareContextSnapshot) throw new ProjectError('INVALID_INPUT', 'Historical snapshot authorization is unavailable.')
  const authorized = await kernel.prepareContextSnapshot({ path: source.path, content: source.content })
  if (authorized.redacted || authorized.content !== source.content)
    throw new ProjectError('INVALID_INPUT', 'This source reference is restricted by current project policy.')
  return { path: source.path, revision: source.revision, contentRevision: source.contentRevision, content: source.content, coverage: structuredClone(record.coverage) }
}

/** Reads the immutable original, and rechecks actual source content even under metadata revision policies. */
export async function resolveProjectFileRef(context: ProjectReferenceContext, fileRef: string): Promise<ProjectFileView> {
  const source = await loadProjectFileView(context, fileRef)
  const kernel = await context.project.kernel()
  const current = await kernel.read({ path: source.path, baseRevision: source.revision, maxChars: Math.max(source.content.length + 1, 1) })
  if (current.redacted || current.truncated || current.hasMore || current.content !== source.content)
    throw new ProjectError('BASE_REVISION_MISMATCH', 'File content changed since this view was displayed.',
      { path: source.path, expected: source.revision, actual: current.snapshot.revision },
      'Read the current target and confirm a new fileRef; reuse unchanged edit text.')
  return source
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
