/**
 * 项目文件引用：源码快照（source:）、可编辑视图（view:，即 fileRef）与续读页（read-page:）的签发与解析。引用是内容哈希，
 * 记录存在会话的上下文载荷里（没有载荷存储时退回进程内存），解析时核对作用域与工作区，编辑前再按当前授权与脱敏复核。
 */

import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import {fileContextFor } from '@velaros-ai/agent/tool-contract'
import { isObject } from '@velaros-ai/core'

import type { PageRecord, ProjectFileView, ProjectReferenceContext, ProjectVisibleCoverage, RefRecord,SourceRecord } from '../../types/file-refs.js'
import { ProjectError } from '../errors.js'

const RefTool = '__project_file_reference__'
const fallbackStores = new WeakMap<object, Map<string, RefRecord>>()
const fallbackScopes = new WeakMap<object, string>()

/** 进程内存兜底时引用归谁：文件上下文作用域、会话对象，都没有时是项目端口对象。 */
function owner(context: ProjectReferenceContext): object {
  const candidate = context.fileContextScope ?? context.codingSession
  return candidate && isObject(candidate) ? candidate : context.project
}

/** 当前引用作用域的标识：宿主给的、文件上下文协调器的，都没有时为引用的归属对象生成一个随机的。只有同一作用域签发的引用才能解析。 */
export function projectFileRefScope(context: ProjectReferenceContext): string {
  if (context.fileRefScopeId) return context.fileRefScopeId
  const coordinator = fileContextFor(context)
  if (coordinator) return coordinator.scopeId
  const key = owner(context)
  let scope = fallbackScopes.get(key)
  if (!scope) fallbackScopes.set(key, (scope = randomUUID()))
  return scope
}

/** 正文的内容版本：UTF-8 正文的 SHA-256 十六进制串。 */
export function projectContentRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 存一条引用记录，返回「前缀 + 记录的内容哈希」形式的引用：有会话载荷存储就存进去，没有就存进进程内存。 */
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

/** 按引用取回记录：格式不对、找不到、不属于当前作用域或属于别的工作区时抛 INVALID_INPUT，并说明只能原样复制框架签发的引用。 */
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

/** 存一份源码快照，返回 source: 引用。快照本身不带编辑权，只有最终呈现给模型时才据它签发 view: 视图。 */
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

/** 把 source:、view: 或 read-page: 引用解析到它背后的源码快照。 */
export async function resolveProjectFileSource(context: ProjectReferenceContext, ref: string): Promise<SourceRecord> {
  const record = await get(context, ref)
  if (record.kind === 'project-file-source') return record
  if (record.kind === 'project-file-view' || record.kind === 'project-read-page')
    return resolveProjectFileSource(context, record.source)
  throw new ProjectError('INVALID_INPUT', '源码引用无效。')
}

/** 按实际显示给模型的可见范围签发可编辑视图，返回 view: 引用（即 fileRef）；传入的不是 source: 引用时先落一份源码快照。 */
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

/** 取回 fileRef 对应的视图（路径、版本、正文、可见范围）：只认 view: 引用，而且历史正文仍要过当前的授权与脱敏，被限制就拒绝编辑。 */
export async function loadProjectFileView(context: ProjectReferenceContext, fileRef: string): Promise<ProjectFileView> {
  const record = await get(context, fileRef)
  if (record.kind !== 'project-file-view' || !fileRef.startsWith('view:'))
    throw new ProjectError('INVALID_INPUT', '这不是可编辑的 fileRef：编辑只接受当前视图或读取结果里的 view:… 引用。', { ref: fileRef }, ReadForReferenceNextAction)
  const source = await resolveProjectFileSource(context, record.source)
  const kernel = await context.project.kernel()
  if (!kernel.prepareContextSnapshot) throw new ProjectError('NOT_SUPPORTED', '当前宿主没有实现历史快照的授权检查，凭 fileRef 的改动都用不了。', undefined,
    '这是宿主缺能力，不是入参问题：告诉用户这个宿主接的项目内核缺 prepareContextSnapshot。')
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

/** 为读到一半的源码签发续读引用（read-page:），记下源码快照和下一页的范围。 */
export async function saveProjectReadPage(
  context: ProjectReferenceContext,
  source: string,
  range: PageRecord['range']
): Promise<string> {
  await resolveProjectFileSource(context, source)
  return put(context, { kind: 'project-read-page', version: 1, source, scope: projectFileRefScope(context), range }, 'read-page:')
}

/** 解析续读引用，返回源码的路径、版本、正文和下一页的范围。 */
export async function resolveProjectReadPage(context: ProjectReferenceContext, ref: string) {
  const page = await get(context, ref)
  if (page.kind !== 'project-read-page') throw new ProjectError('INVALID_INPUT', '续读引用无效。')
  const source = await resolveProjectFileSource(context, page.source)
  return { path: source.path, revision: source.revision, content: source.content, range: page.range, source: page.source }
}
