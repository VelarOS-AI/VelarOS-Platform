/** 把模型的最终文件内容和唯一片段编成现有事务计划；提交回执保留实际应用事实，不依赖历史继续留存。 */
import { randomUUID } from 'node:crypto'

import { isArray, isPlainObject, isString, Log, stableStringify } from '@velaros-ai/core'
import { textCodec } from '@velaros-ai/core/text-files'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type {
  AgentProjectApplyResult,
  AgentProjectStoredTransaction,
} from '../../types/agent-port.js'
import type { EditIntent, ReplaceContentOperation } from '../../types/edit.js'
import type {
  ProjectChangeInput,
  ProjectCommitChange,
  ProjectCommitInput,
  ProjectCommitResult,
  ProjectInspectInput,
} from '../../types/files.js'
import { combineDiffs, unifiedDiff } from '../diff.js'
import { applyProjectMutations } from '../editing/content-planner.js'
import { completeProjectCoverage } from '../editing/planner-coverage.js'
import { selectProjectMutations } from '../editing/select.js'
import { normalizePhysicalNewlines } from '../editing/source.js'
import { ProjectError } from '../errors.js'
import { sha256 } from '../hash.js'
import { countChangedLines } from '../text.js'
import { beforeWrite } from '../transactions/transaction-errors.js'
import { ProjectTuning } from '../tuning.js'

import { changeRecordOf, changeTransactionOf } from './change-records.js'
import { readAgentFile } from './kernel-port.js'
import { projectRelativePath } from './ports.js'
import { projectCreatedPaths, projectFileStats } from './transaction-result.js'

/** 统一 Node 客户端和直接宿主调用的字节表示，使逻辑相同的请求拥有同一指纹。 */
function normalizeChange(change: ProjectCommitChange): ProjectCommitChange {
  if ('oldText' in change) return change
  const source = change.before
  const before =
    source instanceof Uint8Array
      ? { sha256: sha256(Buffer.from(source)) }
      : isString(source)
        ? { sha256: sha256(source) }
        : source
  if ('from' in change) return { ...change, before: before! }
  const after =
    change.after instanceof Uint8Array
      ? { base64: Buffer.from(change.after).toString('base64') }
      : change.after
  return { ...change, before, after }
}

/** 在写门内规划；基线留给写盘时的原字节检查，不用解码文本冒充磁盘版本。 */
async function planCommit(input: ProjectCommitInput, ctx: ProjectOperationContext) {
  const operations: EditIntent[] = []
  const kernel = await ctx.project.kernel()
  const baseRevisions: Record<string, string> = Object.create(null)
  const fragments = new Map<string, ReplaceContentOperation>()
  const currentText = async (path: string) => {
    const file = await readAgentFile(kernel, { path, maxChars: ProjectTuning.agent.fullReadChars })
    if (file.truncated || !isString(file.content) || !file.snapshot.revision)
      throw new ProjectError('SCOPE_VIOLATION', `${path} 超过可完整编辑的文本范围。`)
    baseRevisions[path] = file.snapshot.revision
    return file.content
  }
  const bases: Record<string, string | null> = Object.create(null)
  const bytes: Record<string, string> = Object.create(null)
  const used = new Set<string>()
  const exclusive = new Set<string>()
  for (const change of input.changes) {
    ctx.abortSignal.throwIfAborted()
    const move = 'from' in change
    const path = await projectRelativePath(ctx, move ? change.from : change.path)
    const fragment = 'oldText' in change
    if (exclusive.has(path) || (!fragment && used.has(path)))
      throw new ProjectError('INVALID_INPUT', `${path} 只能指定一次最终状态。`)
    used.add(path)
    if (fragment) {
      if (!isString(change.oldText) || !change.oldText || !isString(change.newText))
        throw new ProjectError('INVALID_INPUT', `${path} 需要唯一的非空 oldText 和字符串 newText。`)
      let op = fragments.get(path)
      if (!op) {
        const content = await currentText(path)
        op = { type: 'replace_content', path, expectedContent: content, content, mode: 'edit' }
        operations.push({ operation: op })
        fragments.set(path, op)
      }
      const view = {
        path,
        revision: baseRevisions[path],
        content: op.content,
        coverage: completeProjectCoverage(op.content),
      }
      const edits = selectProjectMutations(view, [
        { op: 'replace', match: change.oldText, text: change.newText },
      ])
      op.content = applyProjectMutations(view, edits)
      continue
    }
    exclusive.add(path)
    const before = change.before
    if (
      before !== null &&
      !(
        isPlainObject(before) &&
        'sha256' in before &&
        isString(before.sha256) &&
        /^[a-f0-9]{64}$/u.test(before.sha256)
      )
    )
      throw new ProjectError('INVALID_INPUT', `${path} 需要原始字节基线。`)
    bases[path] = before === null ? null : before.sha256
    if (move) {
      const to = await projectRelativePath(ctx, change.to)
      if (used.has(to) || before === null)
        throw new ProjectError('INVALID_INPUT', '移动需要现有源和独立的空目标。')
      used.add(to)
      exclusive.add(to)
      bases[to] = null
      operations.push({ operation: { type: 'rename_file', from: path, to } })
    } else if (change.after === null) {
      if (before === null) throw new ProjectError('INVALID_INPUT', '删除必须提供原始文件基线。')
      operations.push({ operation: { type: 'delete_file', path } })
    } else {
      let text = change.after
      if (!isString(text)) {
        if (!isPlainObject(text) || !('base64' in text) || !isString(text.base64))
          throw new ProjectError('INVALID_INPUT', 'after 需要文本或字节。')
        const buffer = Buffer.from(text.base64, 'base64')
        const decoded = textCodec.decode(buffer)
        if (!decoded || buffer.toString('base64') !== text.base64)
          throw new ProjectError('NOT_SUPPORTED', `${path} 需要可无损解码的文本字节。`)
        bytes[path] = text.base64
        text = decoded.content
      }
      // 显式字节和混合换行原样提交。工具只生成 LF 新文时沿用现有文件的统一 CRLF。
      if (isString(change.after)) text = text.replace(/^\uFEFF/u, '')
      if (before === null)
        operations.push({ operation: { type: 'create_file', path, content: text } })
      else {
        const content = await currentText(path)
        if (
          isString(change.after) &&
          !text.includes('\r\n') &&
          content.includes('\r\n') &&
          !/(?<!\r)\n/u.test(content)
        )
          text = normalizePhysicalNewlines(text, '\r\n')
        operations.push({
          operation: {
            type: 'replace_content',
            path,
            expectedContent: content,
            content: text,
            mode: 'overwrite',
          },
        })
      }
    }
  }
  return {
    operations,
    baseRevisions,
    metadata: { source: 'velaros:project', commitBases: bases, commitBytes: bytes },
  }
}

/** 持久引用只认本会话的事务；历史 change: 回执继续按原签发规则读取。 */
export async function resolveCommit(
  input: ProjectChangeInput,
  ctx: ProjectOperationContext,
  latest: boolean
) {
  const kernel = await ctx.project.kernel()
  const ref = input.changeRef
  if (
    (ref !== undefined && (!isString(ref) || !ref)) ||
    (input.requestId !== undefined && (!isString(input.requestId) || !input.requestId))
  )
    throw new ProjectError('INVALID_INPUT', '事务引用或请求号必须是非空字符串。')
  if (ref && input.requestId)
    throw new ProjectError('INVALID_INPUT', 'changeRef 和 requestId 只指定一个。')
  if (ref?.startsWith('change:')) {
    const record = changeRecordOf(ref, ctx)
    return {
      kernel,
      transaction: await changeTransactionOf(ctx, record.transactionId, ref),
      changeRef: ref,
      record,
    }
  }
  if (!ref && !input.requestId && !latest)
    throw new ProjectError('INVALID_INPUT', '撤回必须指定事务。')
  const owner = ctx.sessionId ?? ''
  const tx = ref ? kernel.getTransaction(ref) : kernel.findCommit?.(owner, input.requestId)
  if (!tx || tx.metadata?.commitSession !== owner)
    throw new ProjectError('TARGET_NOT_FOUND', '本会话在该项目没有可用的匹配事务。')
  return { kernel, transaction: tx, changeRef: tx.transactionId, record: commitRevisions(tx) }
}

/** 给回执取实际版本；新建路径没有写前版本。 */
function commitRevisions(tx: AgentProjectStoredTransaction) {
  const created = projectCreatedPaths(tx.patches)
  const old = tx.metadata?.oldRevisions as Record<string, string> | undefined
  return {
    oldRevisions:
      old && Object.fromEntries(Object.entries(old).filter(([path]) => !created.has(path))),
    newRevisions: tx.metadata?.newRevisions as Record<string, string> | undefined,
  }
}

/** 从事务补丁生成指定路径的净差量，分页只读这次提交的快照。 */
export function inspectedDiff(input: ProjectInspectInput, tx: AgentProjectStoredTransaction) {
  let diff = tx.diff
  if (input.path !== undefined) {
    const patches = tx.patches.filter((p) => p.path === input.path)
    if (!patches.length) throw new ProjectError('TARGET_NOT_FOUND', `该事务未修改 ${input.path}。`)
    diff =
      patches.length === 1
        ? patches[0].diff
        : unifiedDiff(input.path, patches[0].oldContent, patches.at(-1)?.newContent)
  }
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > diff.length)
    throw new ProjectError('INVALID_INPUT', '差量起点超出范围。')
  const end = tx.metadata?.commitRequest ? offset + ProjectFileLimits.commitDiffChars : diff.length
  return {
    diff: diff.slice(offset, end),
    diffLines: input.path === undefined ? tx.changedLines : countChangedLines(diff),
    nextOffset: end < diff.length ? end : undefined,
  }
}

/** 从留存补丁的首尾内容计算反向净差量，兼容一次事务多次修改同一路径的旧记录。 */
export function rollbackDiff(tx: AgentProjectStoredTransaction): string {
  const paths = new Map<string, { before?: string; after?: string }>()
  for (const patch of tx.patches) {
    const existing = paths.get(patch.path)
    if (existing) existing.after = patch.newContent
    else paths.set(patch.path, { before: patch.oldContent, after: patch.newContent })
  }
  return combineDiffs(
    [...paths]
      .reverse()
      .map(([path, contents]) => unifiedDiff(path, contents.after, contents.before))
  )
}

/** 读取事务自身的内容和状态生成有界回执。 */
function receipt(tx: AgentProjectStoredTransaction, requestId: string): ProjectCommitResult {
  const truncated = tx.diff.length > ProjectFileLimits.commitDiffChars
  const settled = tx.status === 'applied' || tx.status === 'rolled_back'
  return {
    changeRef: tx.transactionId,
    requestId,
    status: tx.status,
    changed: settled && tx.changedFiles.length > 0,
    changedFiles: settled ? tx.changedFiles : [],
    diff: tx.diff.slice(0, ProjectFileLimits.commitDiffChars),
    diffTruncated: truncated,
    ...commitRevisions(tx),
  }
}

/** 请求身份和指纹与 prepared 事务一起持久化，应用失败后可查询，重试不会重新应用已提交或撤销的事务。 */
export async function commitFiles(
  input: ProjectCommitInput,
  ctx: ProjectOperationContext
): Promise<ProjectCommitResult> {
  const kernel = await beforeWrite(() => ctx.project.kernel())
  const requestId = input.requestId ?? ctx.invocationId ?? randomUUID()
  const owner = ctx.sessionId ?? ''
  const { changes, fingerprint, existing } = await beforeWrite(() => {
    if (
      !isString(requestId) ||
      !requestId.trim() ||
      requestId.length > ProjectFileLimits.commitRequestChars ||
      !isArray(input.changes) ||
      !input.changes.length ||
      input.changes.length > ProjectFileLimits.steps
    )
      throw new ProjectError(
        'INVALID_INPUT',
        `commit 需要有效的请求号和 1–${ProjectFileLimits.steps} 项文件改动。`
      )
    if (!kernel.findCommit) throw new ProjectError('NOT_SUPPORTED', '项目内核没有持久请求索引。')
    const changes = input.changes.map(normalizeChange)
    const fingerprint = sha256(stableStringify(changes))
    const existing = kernel.findCommit(owner, requestId)
    if (existing && existing.metadata?.commitFingerprint !== fingerprint)
      throw new ProjectError('INVALID_INPUT', '同一 requestId 已用于另一份改动。')
    return { changes, fingerprint, existing }
  })
  if (existing) {
    ctx.recordWriteOutcome?.('not-applied')
    return receipt(existing, requestId)
  }
  const prepared = await beforeWrite(async () => {
    const plan = await planCommit({ ...input, changes }, ctx)
    Object.assign(plan.metadata, {
      commitSession: owner,
      commitRequest: requestId,
      commitFingerprint: fingerprint,
    })
    return kernel.prepareEdit(plan)
  })
  let applied: AgentProjectApplyResult
  try {
    applied = await kernel.applyEdit({ transactionId: prepared.transactionId }, ctx.abortSignal)
  } catch (error) {
    // 已开始恢复或已落盘的事务不可丢弃；保留原始错误和可查询身份。
    const current = kernel.getTransaction(prepared.transactionId)
    if (current?.status === 'prepared' || current?.status === 'validated') {
      try {
        kernel.discardTransaction(prepared.transactionId)
      } catch (cleanupError) {
        Log.tag('ProjectCommit').warn('保留待恢复事务', {
          transactionId: prepared.transactionId,
          error: cleanupError,
        })
      }
    } else if (current?.status === 'applied' && current.changedFiles.length) {
      ctx.recordProjectCommit?.({
        root: ctx.project.getRootPath(),
        transactionId: current.transactionId,
        lifecycle: 'applied',
        changedFiles: current.changedFiles,
        fileStats: projectFileStats(current.patches),
      })
    }
    throw error
  }
  // 应用成功的大事务可以立刻被历史预算淘汰；准备时持有的补丁与实际应用回执仍属于本次提交。
  const tx: AgentProjectStoredTransaction = kernel.getTransaction(prepared.transactionId) ?? {
    ...prepared,
    status: 'applied',
    changedFiles: applied.changedFiles,
    metadata: {
      ...prepared.metadata,
      oldRevisions: applied.oldRevisions,
      newRevisions: applied.newRevisions,
    },
  }
  const result = receipt(tx, requestId)
  if (result.changed)
    ctx.recordProjectCommit?.({
      root: ctx.project.getRootPath(),
      transactionId: tx.transactionId,
      lifecycle: 'applied',
      changedFiles: tx.changedFiles,
      fileStats: projectFileStats(tx.patches),
    })
  ctx.recordWriteOutcome?.(result.changed ? 'applied' : 'not-applied')
  return result
}
