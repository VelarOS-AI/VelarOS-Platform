/**
 * 文件引用：源码快照（source:）、可编辑视图（view:，就是 fileRef）与改动回执（change:）的签发与解析。
 * 引用是记录的内容哈希。记录按会话存在进程内存里，每个会话有条数与字符数上限，最久没用的先出；进程重启后引用全部作废，重读就是。
 * 解析时核对会话与项目根。
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type {
  ProjectFileView,
  ProjectVisibleCoverage,
  ReceiptRecord,
  RefRecord,
  RefSession,
  SourceRecord,
} from '../../types/file-refs.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

/** 每个会话一份记录；会话按最近使用排序，超了从最久没用的那个整份丢掉。 */
const sessions = new Map<string, RefSession>()

/** 引用不可用时的下一步：模型只能原样用签发出来的引用，缺了就去读，不能自己拼。 */
const ReadForReferenceNextAction =
  'fileRef 只能从 read、search 的窗口或上一次 edit 回执的 files 里原样拿；手里没有这个文件的，先 read 一遍要改的那几行。'

/** 当前调用的会话：没给会话号的调用共用一份。 */
function sessionOf(ctx: ProjectOperationContext): RefSession {
  const key = ctx.sessionId ?? ''
  const found = sessions.get(key)
  if (found) {
    sessions.delete(key)
    sessions.set(key, found)
    return found
  }
  const created: RefSession = { records: new Map(), chars: 0 }
  sessions.set(key, created)
  while (sessions.size > ProjectTuning.refs.sessions) sessions.delete(sessions.keys().next().value!)
  return created
}

/** 正文的内容版本：UTF-8 正文的 SHA-256 十六进制串。 */
export function projectContentRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 存一条记录，返回「前缀 + 记录的内容哈希」形式的引用；同样的记录再存一次只是挪到最近。 */
function put(ctx: ProjectOperationContext, value: RefRecord, prefix: string): string {
  const serialized = JSON.stringify(value)
  const hash = projectContentRevision(serialized)
  const session = sessionOf(ctx)
  const existing = session.records.get(hash)
  if (existing) {
    session.records.delete(hash)
    session.chars -= existing.chars
  }
  session.records.set(hash, { record: value, chars: serialized.length })
  session.chars += serialized.length
  while (
    session.records.size > 1 &&
    (session.records.size > ProjectTuning.refs.recordsPerSession ||
      session.chars > ProjectTuning.refs.charsPerSession)
  ) {
    const [oldest, entry] = session.records.entries().next().value!
    session.records.delete(oldest)
    session.chars -= entry.chars
  }
  return `${prefix}${hash}`
}

/** 按引用取回记录：格式不对、这个会话里没有（别的会话签发的，或者已经挤出去了）时抛 INVALID_INPUT。 */
function get(ctx: ProjectOperationContext, ref: string, prefixes: readonly string[]): RefRecord {
  const prefix = prefixes.find((candidate) => ref.startsWith(candidate))
  const hash = prefix ? ref.slice(prefix.length) : ''
  if (!prefix || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new ProjectError(
      'INVALID_INPUT',
      `${JSON.stringify(ref.slice(0, 80))} 不是签发出来的引用（${prefixes.join(' / ')} 加 64 位十六进制），不能手写或改写。`,
      { ref: ref.slice(0, 80) },
      ReadForReferenceNextAction
    )
  }
  const session = sessionOf(ctx)
  const entry = session.records.get(hash)
  if (!entry) {
    throw new ProjectError(
      'INVALID_INPUT',
      '这个引用不是本会话签发的，或者已经过期（进程重启过，或者本会话签发的引用太多、它被挤掉了）。',
      { ref },
      ReadForReferenceNextAction
    )
  }
  session.records.delete(hash)
  session.records.set(hash, entry)
  return entry.record
}

/** 签发引用的项目必须就是当前项目：项目换了，引用就作废。 */
function assertCurrentProject(ctx: ProjectOperationContext, root: string, ref: string): void {
  if (root !== currentRoot(ctx))
    throw new ProjectError(
      'INVALID_INPUT',
      '这个引用属于另一个项目，在这里用不了。',
      { ref },
      ReadForReferenceNextAction
    )
}

/** 当前项目根的绝对路径：引用记录里记的就是它。 */
function currentRoot(ctx: ProjectOperationContext): string {
  return resolve(ctx.project.getRootPath())
}

/** 存一份源码快照，返回 source: 引用。快照本身不带编辑权，只有真正交给程序的窗口才据它签发 view: 视图。 */
export function saveFileSource(
  ctx: ProjectOperationContext,
  input: { path: string; revision: string; content: string }
): string {
  return put(
    ctx,
    {
      kind: 'project-file-source',
      version: 1,
      root: currentRoot(ctx),
      ...input,
      contentRevision: projectContentRevision(input.content),
    },
    'source:'
  )
}

/** 把 source: 或 view: 引用解析到它背后的源码快照。 */
export function resolveFileSource(ctx: ProjectOperationContext, ref: string): SourceRecord {
  const record = get(ctx, ref, ['source:', 'view:'])
  if (record.kind === 'project-file-source') return record
  if (record.kind === 'project-file-view') return resolveFileSource(ctx, record.source)
  throw new ProjectError('INVALID_INPUT', '源码引用无效。', { ref }, ReadForReferenceNextAction)
}

/** 按实际交出去的可见范围签发可编辑视图，返回 view: 引用（就是 fileRef）；传入的不是 source: 引用时先落一份源码快照。 */
export function saveFileRef(
  ctx: ProjectOperationContext,
  source: string,
  coverage: ProjectVisibleCoverage[]
): string {
  const record = resolveFileSource(ctx, source)
  const sourceRef = source.startsWith('source:') ? source : put(ctx, record, 'source:')
  return put(ctx, { kind: 'project-file-view', version: 1, source: sourceRef, coverage }, 'view:')
}

/** 取回 fileRef 对应的视图（路径、版本、正文、可见范围）：只认 view: 引用，而且要是当前项目签发的。 */
export async function loadFileView(
  ctx: ProjectOperationContext,
  fileRef: string
): Promise<ProjectFileView> {
  const record = get(ctx, fileRef, ['view:', 'source:'])
  if (record.kind !== 'project-file-view') {
    throw new ProjectError(
      'INVALID_INPUT',
      '这不是可编辑的 fileRef：编辑只收窗口上的 view:… 引用。',
      { ref: fileRef },
      ReadForReferenceNextAction
    )
  }
  const source = resolveFileSource(ctx, record.source)
  assertCurrentProject(ctx, source.root, fileRef)
  return {
    path: source.path,
    revision: source.revision,
    contentRevision: source.contentRevision,
    content: source.content,
    coverage: structuredClone(record.coverage),
  }
}

/**
 * 取回 fileRef 的视图并按正文复核当前文件。正文没变就沿用当前 revision（元数据型 revision 策略下只动了 mtime 不算过期），
 * 正文变了按过期拒绝，由编辑恢复链给出新位置。
 */
export async function resolveFileRef(
  ctx: ProjectOperationContext,
  fileRef: string
): Promise<ProjectFileView> {
  const view = await loadFileView(ctx, fileRef)
  const kernel = await ctx.project.kernel()
  const current = await kernel.read({
    path: view.path,
    maxChars: Math.max(view.content.length + 1, 1),
  })
  if (
    current.truncated ||
    current.hasMore ||
    current.content !== view.content ||
    !current.snapshot.revision
  ) {
    throw new ProjectError(
      'BASE_REVISION_MISMATCH',
      `${view.path} 在这个 fileRef 之后改过（当前版本 ${current.snapshot.revision ?? '未知'}）。`,
      { path: view.path, expected: view.revision, actual: current.snapshot.revision },
      '可能就是你上一次改的：用上一次 edit 回执里这个文件的新 fileRef 按新行号重做；回执里没有这个文件的，重新 read 要改的那几行。'
    )
  }
  return { ...view, revision: current.snapshot.revision }
}

/** 每种回执引用的来历与下一步：引用只能原样用本会话签发的，坏了就照这句重来。 */
const ReceiptNextActions: Readonly<Record<string, string>> = Object.freeze({
  change: 'changeRef 只能原样用本会话 edit 回执里的值。',
})

/** 存一张回执，返回「kind: + 内容哈希」形式的不透明引用。 */
export function saveReceipt(ctx: ProjectOperationContext, kind: string, value: unknown): string {
  return put(
    ctx,
    { kind: 'project-receipt', version: 1, receipt: kind, root: currentRoot(ctx), value },
    `${kind}:`
  )
}

/** 凭引用取回回执内容：种类不对、会话里没有、或属于别的项目时按 INVALID_INPUT 拒绝，并说明怎么拿到有效的引用。 */
export function readReceipt(ctx: ProjectOperationContext, kind: string, ref: string): unknown {
  const next = ReceiptNextActions[kind] ?? '引用只能原样用本会话回执里的值，不能手写或改写。'
  let record: RefRecord
  try {
    record = get(ctx, ref, [`${kind}:`])
  } catch (error) {
    if (error instanceof ProjectError)
      throw new ProjectError(error.reason, error.message, error.details, next)
    throw error
  }
  if (record.kind !== 'project-receipt' || record.receipt !== kind) {
    throw new ProjectError(
      'INVALID_INPUT',
      `${ref.slice(0, 80)} 不是本会话签发的 ${kind} 引用。`,
      { ref: ref.slice(0, 80) },
      next
    )
  }
  if (record.root !== currentRoot(ctx))
    throw new ProjectError(
      'INVALID_INPUT',
      '这个引用属于另一个项目。',
      { ref: ref.slice(0, 80) },
      next
    )
  return (record as ReceiptRecord).value
}
