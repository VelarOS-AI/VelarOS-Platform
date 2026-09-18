/**
 * 代码面 `files` 命名空间的三个操作：`FileOperations` 与整个进程唯一的 `fileOperations`。接口 `FileOperationsApi` 在本文件的类上方。
 * 本机文件（系统空间）的读、写、撤回：有界地读、认编码、按行拆合、核版本、留原文、一批的成败在这里只做一份；
 * 空间的差别全交给注入的 `FileSpacePort`：路径怎么解析、哪些要问人、怎么落盘。项目里的文件另有一套（`velar:project`）。
 */

import { stat } from 'node:fs/promises'

import { isArray, isBlank, isEmpty, isNull, isPresent, isString, isUndefined, Log, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { PlatformCompatibilityApi } from '@velaros-ai/core/platform'
import { currentPlatform } from '@velaros-ai/core/platform'
import { textCodec } from '@velaros-ai/core/text-files'

import { FileErrorCodes, FileLimits } from '../contract/constants.js'
import type { FileOperationContext } from '../contract/requires.js'
import type { FileChangeEntry, FileEditPlan, FileEditProblem } from '../types/edit.js'
import type {
  FileEditInput,
  FileEditItem,
  FileEditResult,
  FileLocation,
  FileReadInput,
  FileReadItem,
  FileUndoInput,
  FileUndone,
  FileUndoResult,
  FileWritten,
} from '../types/files.js'
import type { FileWrite } from '../types/space.js'
import type { FileReadResult, FileText } from '../types/text.js'
import { batchItems, commitFailure, failureEntry, unresolvedEditFailure, withLinkTarget, writeOfPlan } from '../utils/batch.js'
import { lineSpan, numberedLines, splitLines } from '../utils/lines.js'
import { fileIdentity } from '../utils/paths.js'
import { planFileEdit } from '../utils/plan.js'
import {
  currentFileVersion,
  decodeText,
  detectMediaType,
  fileVersionOf,
  readBoundedFile,
  readRawFile,
  stampOf,
  stampProvesUnchanged,
} from '../utils/text-file.js'

import type { FileChangesApi } from './FileChanges.js'
import { FileChanges } from './FileChanges.js'

const log = Log.tag('FileOperations')

/**
 * 代码面的一个命名空间：模型在程序里写 `read(...)`、`edit(...)`、`undo(...)`，挂它的空间注入自己的 `FileSpacePort`。
 * 实现是 `FileOperations`，整个进程只有一份（`fileOperations`）。
 *
 * @AgentView
 * 读写本机上的文本文件。下面这几件事三个方法都成立，各自说明里不再重复：
 * 相对路径、`~` 怎么解析，哪些路径越出了范围，由当前空间决定（环境报告里写着）；越界的直接拒绝。
 * 读出来的是带行号的行；改的时候按行号改几处，或者整份写。读写保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030）与换行风格，
 * 认不出编码或有非法字节的按二进制处理。写是原子的，失败不会留下半截文件；路径是符号链接时读写它指向的那个文件，链接本身不变。
 * 列目录、搜文本用命令做（`velar:shell` 的 run：ls、find、`rg -n`）；看图片用 `velar:images`。
 */
export interface FileOperationsApi {
  /**
   * @AgentView
   * 读文本文件：每个文件交回带行号的行（给了 range 就只交那几行）和整个文件的版本号。
   * 图片、PDF 与其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  read(input: FileReadInput, ctx: FileOperationContext): Promise<FileReadResult>
  /**
   * @AgentView
   * 改文件：按行号改几处，或者整份写。**优先整批改**：files 里放几个就改几个，整批一次成败，成了给一个 changeId。
   * 定下改法之后、写进去之前文件被别人改过，整批不写。
   * 路径是管道、设备、套接字，或文件有多个硬链接时不碰。新内容编不成原编码（孤立代理项、GB18030 表示不了的字符）就整批不写。
   */
  edit(input: FileEditInput, ctx: FileOperationContext): Promise<FileEditResult>
  /**
   * @AgentView
   * 撤回一次 edit：那次改的每个文件回到改动前，那次新建的删掉，整次一起。只留最近 50 次改动。
   */
  undo(input: FileUndoInput, ctx: FileOperationContext): Promise<FileUndoResult>
}

export class FileOperations implements FileOperationsApi {
  constructor(
    private readonly platform: PlatformCompatibilityApi,
    private readonly changes: FileChangesApi,
  ) {}

  public async read(input: FileReadInput, ctx: FileOperationContext): Promise<FileReadResult> {
    ctx.abortSignal.throwIfAborted()
    const items = batchItems<FileReadItem>(input, FileLimits.readFiles, 'read')
    const files: FileReadResult['files'] = []
    let failed = 0
    let firstFailure: Nullable<AppError> = null
    // 一次调用总共最多交回 readChars 个字符：预算用完之后的文件根本不读盘，那一项换成失败条目。
    // 这个预算保护的是这一侧的内存与 IPC——行落在程序的变量里，模型看不到它。
    let remaining = FileLimits.readChars
    for (const item of items) {
      try {
        if (remaining <= 0) throw new AppError('VALIDATION', `本次调用的 ${FileLimits.readChars} 字符预算已被前面的文件用完，这个文件没有读；另起一次调用再读`)
        const result = await this.readOne(item, remaining, ctx)
        remaining -= result.lines.reduce((sum, [, text]) => sum + text.length, 0)
        files.push(result)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one file in a read batch failed', { code: failure.code })
        failed += 1
        firstFailure ??= failure
        files.push(failureEntry(String(item.path), failure))
      }
    }
    if (failed === items.length && firstFailure) throw firstFailure
    return { files }
  }

  public async edit(input: FileEditInput, ctx: FileOperationContext): Promise<FileEditResult> {
    ctx.abortSignal.throwIfAborted()
    const items = batchItems<FileEditItem>(input, FileLimits.editFiles, 'edit')
    // 第一段：每个文件定位、按真实路径判重、把改法定下来，不写。
    // 有任何问题就整批失败，问题全部列出来让程序一次改完。
    const plans: FileEditPlan[] = []
    const problems: FileEditProblem[] = []
    const seen = new Set<string>()
    for (const [index, item] of items.entries()) {
      const problem = (reason: FileEditProblem['reason'], message: string, path = String(item.path)): FileEditProblem => ({ file: index, path, reason, message })
      const location = await this.locate(item.path, ctx).catch((error: unknown) => AppError.from(error))
      if (location instanceof AppError) {
        problems.push(problem(location.code === 'PERMISSION' ? 'denied' : 'invalid', location.message))
        continue
      }
      const identity = fileIdentity(location.target, this.platform.getPlatform())
      if (seen.has(identity)) {
        problems.push(problem('invalid', '同一个文件在这一批里出现了不止一次（写法不同、经符号链接指向同一个文件的也算）；把它的改动合进一项', location.path))
        continue
      }
      seen.add(identity)
      const planned = await planFileEdit(index, location, item)
      if ('reason' in planned) problems.push(planned)
      else plans.push(planned)
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)

    // 定改法的这段时间里文件可能又被别人改了：写之前再 stat 一次，印记没变的大文件不重读，其余重读核版本；变了就整批不写。
    for (const plan of plans) {
      const now = stampOf(await stat(plan.target).catch(() => null))
      if (stampProvesUnchanged(plan.stamp, now)) continue
      const current = await currentFileVersion(plan.target)
      if (current !== plan.baseVersion) {
        problems.push({ file: plan.index, path: plan.path, reason: 'stale', message: '定下改法之后文件又被改过了；重新读一遍再改', currentVersion: toOptional(current) })
      }
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)

    // 第二段：整批交给空间落盘；写进去的记成一次改动，`undo` 凭它的号整次撤回。
    try {
      await ctx.files.commit(plans.map(writeOfPlan))
    } catch (error) {
      throw commitFailure(error, plans, (applied) => {
        const partial = this.recordChange(applied)
        return partial.undoable ? partial.changeId : null
      })
    }
    const record = this.recordChange(plans)
    const files = plans.map((plan) => withLinkTarget<FileWritten>(
      { path: plan.path, created: plan.created, version: fileVersionOf(plan.bytes), totalLines: plan.totalLines },
      plan.target,
      plan.linked,
    ))
    return { changeId: record.changeId, undoable: record.undoable, files }
  }

  public async undo(input: FileUndoInput, ctx: FileOperationContext): Promise<FileUndoResult> {
    ctx.abortSignal.throwIfAborted()
    const changeId = (input as Partial<FileUndoInput> | undefined)?.changeId
    if (!isString(changeId) || isBlank(changeId)) throw new AppError('VALIDATION', 'undo 要 { changeId }：原样用 edit 结果里的 changeId')
    const record = this.changes.recall(changeId)
    if (!record) throw new AppError('NOT_FOUND', `没有 ${changeId} 这次改动：号不对，或者它已经太旧（只留最近 ${FileLimits.undoChanges} 次），撤不回了`)
    if (record.undone) return { changeId, alreadyUndone: true, files: [] }
    if (!record.undoable) throw new AppError('VALIDATION', `这次改动撤不回：有文件改之前超过 ${FileLimits.undoBytes} 字节，原文没留下来；要改回去就再 edit 一次`)

    // 先核对每个文件：还是那次改完的样子的要撤；已经是改之前的样子的（上一次撤回做了一半）跳过；别的就是之后又被改过，整个不撤。
    const pending: Array<{ entry: FileChangeEntry; current: Buffer }> = []
    const conflicts: string[] = []
    for (const entry of record.entries) {
      const bytes = await readRawFile(entry.target, entry.path).catch(() => null)
      const version = bytes ? fileVersionOf(bytes) : null
      const alreadyBack = isNull(entry.before) ? !bytes : Boolean(bytes && entry.before && bytes.equals(entry.before))
      if (bytes && version === entry.after && !alreadyBack) pending.push({ entry, current: bytes })
      else if (!alreadyBack) conflicts.push(bytes ? `${entry.path}（现在是 ${version}）` : `${entry.path}（已经不在了）`)
    }
    if (!isEmpty(conflicts)) {
      throw new AppError(FileErrorCodes.undoConflict, `这些文件在那次改动之后又被改过，一个文件都没撤：${conflicts.join('、')}；read 看看现状，要改回去就再 edit 一次`)
    }
    const writes: FileWrite[] = pending.map(({ entry, current }) => ({ target: entry.target, bytes: toNullable(entry.before), expected: { exists: true, bytes: current } }))
    try {
      await ctx.files.commit(writes)
    } catch (error) {
      const failure = AppError.from(error)
      const applied = isArray(failure.context.applied) ? failure.context.applied.filter(isString) : []
      const restored = pending.filter(({ entry }) => applied.includes(entry.target)).map(({ entry }) => entry.path)
      const message = isEmpty(restored)
        ? `撤回没做成，一个文件都没动：${failure.message}`
        : `撤回做到一半出错了：已经退回去的是 ${restored.join('、')}；出错的原因：${failure.message}。再 undo 一次会接着撤剩下的`
      throw new AppError(failure.code, message, error, failure.context)
    }
    this.changes.markUndone(changeId)
    return {
      changeId,
      files: pending.map(({ entry }) => withLinkTarget<FileUndone>({ path: entry.path, action: isNull(entry.before) ? 'deleted' : 'restored' }, entry.target, entry.linked)),
    }
  }

  /** 把一批已经写进去的计划记成一次改动：改动前的原文（新建的记 null，太大没留的缺席）与改完的版本。 */
  private recordChange(plans: readonly FileEditPlan[]) {
    return this.changes.record(plans.map((plan) => {
      const entry: FileChangeEntry = { path: plan.path, target: plan.target, linked: plan.linked, after: fileVersionOf(plan.bytes) }
      if (plan.created) entry.before = null
      else if (!isUndefined(plan.previous)) entry.before = plan.previous
      return entry
    }))
  }

  /** 读一个文件：定位、有界读、认出图片与文档就拒、严格解码，再按 range 交出带行号的行；超过这次调用剩下的预算就这一项失败，不回半份。 */
  private async readOne(item: FileReadItem, budgetChars: number, ctx: FileOperationContext): Promise<FileText> {
    const { path, target, linked } = await this.locate(item.path, ctx)
    const span = isPresent(item.range) ? lineSpan(item.range) : null
    if (isPresent(item.range) && !span) throw new AppError('VALIDATION', `range 要行号或 [首行, 末行]（从 1 起，末行不小于首行），这里给的是 ${JSON.stringify(item.range)}`)
    const buffer = await readBoundedFile(target, path, FileLimits.fileBytes)
    // 先认文本：内容恰好以 GIF8、%PDF- 开头的文本文件照样是文本；解不出文本的，再看是不是图片或文档，把该怎么办说清楚。
    const decoded = textCodec.decode(buffer)
    const media = decoded ? null : detectMediaType(buffer)
    if (media) throw new AppError('VALIDATION', media.kind === 'image' ? `${path} 是图片，用 velar:images 的 view 看` : `${path} 是 PDF，不是文本；文档不在这里读`)
    const { content, encoding } = decoded ?? decodeText(buffer, path)
    const text = splitLines(content)
    const [from, to] = span ?? [1, text.lines.length]
    if (span && from > Math.max(text.lines.length, 1)) throw new AppError('VALIDATION', `${path} 只有 ${text.lines.length} 行，range 从第 ${from} 行起`)
    const lines = numberedLines(text, from, to)
    const chars = lines.reduce((sum, [, line]) => sum + line.length, 0)
    if (chars > budgetChars) {
      throw new AppError('VALIDATION', `${path} 要交回 ${chars} 个字符，这次调用前面的文件已经用掉了大半预算，剩下 ${budgetChars}；把它单独放进一次 read，或者用 range 少读几行`)
    }
    return withLinkTarget<FileText>({ path, version: fileVersionOf(buffer), encoding, totalLines: text.lines.length, lines }, target, linked)
  }

  /** 把模型给的路径交给空间定下来：先规整特殊空白与开头的 `@`，不是字符串的直接拒绝。 */
  private locate(path: unknown, ctx: FileOperationContext): Promise<FileLocation> {
    if (!isString(path) || isBlank(path)) return Promise.reject(new AppError('VALIDATION', '每一项都要有 path（字符串）'))
    return ctx.files.locate(this.platform.normalizeUserPathInput(path))
  }
}

/** 整个进程只有一份的文件操作；宿主把它挂在代码面的 `files` 命名空间上，每次调用时把自己空间的端口塞进 ctx。 */
export const fileOperations: FileOperationsApi = new FileOperations(currentPlatform, new FileChanges())
