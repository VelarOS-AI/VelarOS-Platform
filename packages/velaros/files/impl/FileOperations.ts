/**
 * 代码面 `files` 命名空间的三个操作：`FileOperations` 与整个进程唯一的 `fileOperations`。接口 `FileOperationsApi` 在本文件的类上方。
 * 本机文件（系统空间）的读、写、撤回：有界地读、认编码、按路径逐步改、核版本、留原文、一次改动的成败在这里只做一份；
 * 空间的差别全交给注入的 `FileSpacePort`：路径怎么解析、哪些要问人、怎么落盘。项目里的文件另有一套（`velaros:project`）。
 */

import { stat } from 'node:fs/promises'

import {
  isArray,
  isBlank,
  isEmpty,
  isNull,
  isPresent,
  isString,
  isUndefined,
  Log,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { PlatformCompatibilityApi } from '@velaros-ai/core/platform'
import { currentPlatform } from '@velaros-ai/core/platform'
import { textCodec } from '@velaros-ai/core/text-files'

import { FileErrorCodes, FileLimits } from '../contract/constants.js'
import type { FileOperationContext } from '../contract/requires.js'
import type {
  FileChangeEntry,
  FileEditDraft,
  FileEditPlan,
  FileEditProblem,
} from '../types/edit.js'
import type {
  FileEditInput,
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
import {
  batchItems,
  commitFailure,
  failureEntry,
  unresolvedEditFailure,
  withLinkTarget,
  writeOfPlan,
} from '../utils/batch.js'
import { lineSpan, splitLines, windowText } from '../utils/lines.js'
import { fileIdentity } from '../utils/paths.js'
import { applyStep, finishDraft, openDraft, parseStep } from '../utils/plan.js'
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
 * 读出来的是连续的正文，带第一行的行号；改的时候按路径写：整份写进去，或者把一段原文换成新文。读写保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030）与换行风格，
 * 认不出编码或有非法字节的按二进制处理。写是原子的，失败不会留下半截文件；路径是符号链接时读写它指向的那个文件，链接本身不变。
 * 列目录、搜文本用命令做（`velaros:shell` 的 run：ls、find、`rg -n`）；看图片用 `velaros:images`。
 */
export interface FileOperationsApi {
  /**
   * @AgentView
   * 读文本文件：每个文件交回连续的正文与它第一行的行号（给了 range 就只交那几行）。
   * 图片、PDF 与其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   * 一批里用 'error' in file 区分失败，全部失败才抛错；后续修改依赖全部请求时先处理失败项，不跳过它们继续改成功的那部分。
   * @OperationEffect none
   */
  read(input: FileReadInput, ctx: FileOperationContext): Promise<FileReadResult>
  /**
   * @AgentView
   * 改文件：按路径一步一步写，write 整份写、replace 把一段原文换掉。**优先一次改完**：几个文件、几处改动都放进 steps；先统一核对计划，成功后给一个 changeId。
   * 每个文件在落盘时核对原始版本，单个文件原子替换。落盘途中失败可能已有部分写入，报错会点名已写文件及可用的撤回号，先读现状再处理。
   * 保留完整 error.code 与 error.message；提交失败不要整批重发，也不要将一次批量提交当成跨文件事务。
   * 路径是管道、设备、套接字，或文件有多个硬链接时不碰。新内容编不成原编码（孤立代理项、GB18030 表示不了的字符）就整次不写。
   * @OperationEffect write
   */
  edit(input: FileEditInput, ctx: FileOperationContext): Promise<FileEditResult>
  /**
   * @AgentView
   * 撤回一次 edit：那次改的每个文件回到改动前，那次新建的删掉。逐项原子提交，途中失败会报告已撤回文件，再调用会接着撤；只留最近 50 次改动。撤回重新核验当前空间对原路径的授权，且真实目标必须一致。
   * @OperationEffect write
   */
  undo(input: FileUndoInput, ctx: FileOperationContext): Promise<FileUndoResult>
}

export class FileOperations implements FileOperationsApi {
  constructor(
    private readonly platform: PlatformCompatibilityApi,
    private readonly changes: FileChangesApi
  ) {}

  public async read(input: FileReadInput, ctx: FileOperationContext): Promise<FileReadResult> {
    ctx.abortSignal.throwIfAborted()
    const items = batchItems<FileReadItem>(input, FileLimits.readFiles, 'read')
    const files: FileReadResult['files'] = []
    let failed = 0
    let firstFailure: Nullable<AppError> = null
    // 一次调用总共最多交回 readChars 个字符：预算用完之后的文件根本不读盘，那一项换成失败条目。
    // 这个预算保护的是这一侧的内存与 IPC——正文落在程序的变量里，模型看不到它。
    let remaining = FileLimits.readChars
    for (const item of items) {
      ctx.abortSignal.throwIfAborted()
      try {
        if (remaining <= 0)
          throw new AppError(
            'VALIDATION',
            `本次调用的 ${FileLimits.readChars} 字符预算已被前面的文件用完，这个文件没有读；另起一次调用再读`
          )
        const result = await this.readOne(item, remaining, ctx)
        ctx.abortSignal.throwIfAborted()
        remaining -= result.text.length
        files.push(result)
      } catch (error) {
        ctx.abortSignal.throwIfAborted()
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
    const steps = batchItems(input, FileLimits.editSteps, 'edit')
    // 第一段：每一步定位、按真实路径把同一个文件的几步归到一起，在内存里按顺序改好，不写。
    // 有任何问题就整次失败，问题全部列出来让程序一次改完；一个文件出了问题，它后面的几步不再看。
    const drafts = new Map<string, FileEditDraft>()
    const broken = new Set<string>()
    // 出了问题、还没认出是哪个文件的那几步：按原样的写法记着。后面同一个路径上形状没毛病的步骤不再看，
    // 免得报出连带的问题（前一步没写成，后一步自然找不到原文）；形状本身不对的照样逐条报。
    const brokenPaths = new Set<string>()
    const problems: FileEditProblem[] = []
    for (const [index, step] of steps.entries()) {
      ctx.abortSignal.throwIfAborted()
      const problem = (
        reason: FileEditProblem['reason'],
        message: string,
        path = String(step.path)
      ): FileEditProblem => ({ step: index, path, reason, message })
      const parsed = parseStep(step)
      if (isString(parsed)) {
        problems.push(problem('invalid', parsed))
        brokenPaths.add(String(step.path))
        continue
      }
      if (brokenPaths.has(parsed.path)) continue
      const location = await this.locate(parsed.path, ctx).catch((error: unknown) =>
        AppError.from(error)
      )
      ctx.abortSignal.throwIfAborted()
      if (location instanceof AppError) {
        problems.push(
          problem(location.code === 'PERMISSION' ? 'denied' : 'invalid', location.message)
        )
        brokenPaths.add(parsed.path)
        continue
      }
      const identity = fileIdentity(location.target, this.platform.getPlatform())
      if (broken.has(identity)) continue
      let draft = drafts.get(identity)
      if (!draft) {
        if (drafts.size + broken.size >= FileLimits.editFiles)
          throw new AppError(
            'VALIDATION',
            `edit 一次最多改 ${FileLimits.editFiles} 个文件，steps[${index}] 碰到了第 ${FileLimits.editFiles + 1} 个；分几次调用`
          )
        const opened = await openDraft(index, location)
        ctx.abortSignal.throwIfAborted()
        if ('reason' in opened) {
          problems.push(opened)
          broken.add(identity)
          continue
        }
        draft = opened
        drafts.set(identity, draft)
      }
      const failed = applyStep(draft, parsed)
      if (failed) {
        problems.push(problem('invalid', failed, location.path))
        drafts.delete(identity)
        broken.add(identity)
      }
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)
    const plans: FileEditPlan[] = []
    for (const draft of drafts.values()) {
      const planned = finishDraft(draft)
      if ('reason' in planned) problems.push(planned)
      else plans.push(planned)
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)

    // 定改法的这段时间里文件可能又被别人改了：写之前再 stat 一次，印记没变的大文件不重读，其余重读核版本；变了就整次不写。
    for (const plan of plans) {
      const now = stampOf(await stat(plan.target).catch(() => null))
      if (stampProvesUnchanged(plan.stamp, now)) continue
      if ((await currentFileVersion(plan.target)) !== plan.baseVersion) {
        problems.push({
          step: plan.step,
          path: plan.path,
          reason: 'stale',
          message:
            '定下改法之后文件又被别处改过了；重新提交这次 edit（replace 会按新的内容找原文）',
        })
      }
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)

    // 第二段：整次交给空间落盘；写进去的记成一次改动，`undo` 凭它的号整次撤回。
    try {
      ctx.abortSignal.throwIfAborted()
      await ctx.files.commit(plans.map(writeOfPlan), ctx.abortSignal)
    } catch (error) {
      throw commitFailure(error, plans, (applied) => {
        const partial = this.recordChange(applied)
        return partial.undoable ? partial.changeId : null
      })
    }
    const record = this.recordChange(plans)
    const files = plans.map((plan) =>
      withLinkTarget<FileWritten>(
        { path: plan.path, created: plan.created, totalLines: plan.totalLines },
        plan.target,
        plan.linked
      )
    )
    return { changeId: record.changeId, undoable: record.undoable, files }
  }

  public async undo(input: FileUndoInput, ctx: FileOperationContext): Promise<FileUndoResult> {
    ctx.abortSignal.throwIfAborted()
    const changeId = (input as Partial<FileUndoInput> | undefined)?.changeId
    if (!isString(changeId) || isBlank(changeId))
      throw new AppError('VALIDATION', 'undo 要 { changeId }：原样用 edit 结果里的 changeId')
    const record = this.changes.recall(changeId)
    if (!record)
      throw new AppError(
        'NOT_FOUND',
        `没有 ${changeId} 这次改动：号不对，或者它已经太旧（只留最近 ${FileLimits.undoChanges} 次），撤不回了`
      )
    if (record.undone) return { changeId, alreadyUndone: true, files: [] }
    if (!record.undoable)
      throw new AppError(
        'VALIDATION',
        `这次改动撤不回：有文件改之前超过 ${FileLimits.undoBytes} 字节，原文没留下来；要改回去就再 edit 一次`
      )

    // 句柄只定位历史记录；权限仍来自本次调用的路径解析，端口可以由宿主逐次重建。
    for (const entry of record.entries) {
      const location = await this.locate(entry.path, ctx)
      ctx.abortSignal.throwIfAborted()
      if (
        fileIdentity(location.target, this.platform.getPlatform()) !==
        fileIdentity(entry.target, this.platform.getPlatform())
      )
        throw new AppError(
          'PERMISSION',
          `撤回目标已改变：${entry.path}；当前路径不再指向那次改动的文件`
        )
    }
    // 先核对每个文件：还是那次改完的样子的要撤；已经是改之前的样子的（上一次撤回做了一半）跳过；别的就是之后又被改过，整个不撤。
    const pending: Array<{ entry: FileChangeEntry; current: Buffer }> = []
    const conflicts: string[] = []
    for (const entry of record.entries) {
      const bytes = await readRawFile(entry.target, entry.path).catch(() => null)
      const version = bytes ? fileVersionOf(bytes) : null
      const alreadyBack = isNull(entry.before)
        ? !bytes
        : Boolean(bytes && entry.before && bytes.equals(entry.before))
      if (bytes && version === entry.after && !alreadyBack) pending.push({ entry, current: bytes })
      else if (!alreadyBack) conflicts.push(bytes ? entry.path : `${entry.path}（已经不在了）`)
    }
    if (!isEmpty(conflicts)) {
      throw new AppError(
        FileErrorCodes.undoConflict,
        `这些文件在那次改动之后又被改过，一个文件都没撤：${conflicts.join('、')}；read 看看现状，要改回去就再 edit 一次`
      )
    }
    const writes: FileWrite[] = pending.map(({ entry, current }) => ({
      target: entry.target,
      bytes: toNullable(entry.before),
      expected: { exists: true, bytes: current },
    }))
    try {
      ctx.abortSignal.throwIfAborted()
      await ctx.files.commit(writes, ctx.abortSignal)
    } catch (error) {
      const failure = AppError.from(error)
      const applied = isArray(failure.context.applied)
        ? failure.context.applied.filter(isString)
        : []
      const restored = pending
        .filter(({ entry }) => applied.includes(entry.target))
        .map(({ entry }) => entry.path)
      const message = isEmpty(restored)
        ? `撤回没做成，一个文件都没动：${failure.message}`
        : `撤回做到一半出错了：已经退回去的是 ${restored.join('、')}；出错的原因：${failure.message}。再 undo 一次会接着撤剩下的`
      throw new AppError(failure.code, message, error, failure.context)
    }
    this.changes.markUndone(changeId)
    return {
      changeId,
      files: pending.map(({ entry }) =>
        withLinkTarget<FileUndone>(
          { path: entry.path, action: isNull(entry.before) ? 'deleted' : 'restored' },
          entry.target,
          entry.linked
        )
      ),
    }
  }

  /** 把一批已经写进去的计划记成一次改动：改动前的原文（新建的记 null，太大没留的缺席）与改完的版本。 */
  private recordChange(plans: readonly FileEditPlan[]) {
    return this.changes.record(
      plans.map((plan) => {
        const entry: FileChangeEntry = {
          path: plan.path,
          target: plan.target,
          linked: plan.linked,
          after: fileVersionOf(plan.bytes),
        }
        if (plan.created) entry.before = null
        else if (!isUndefined(plan.previous)) entry.before = plan.previous
        return entry
      })
    )
  }

  /** 读一个文件：定位、有界读、认出图片与文档就拒、严格解码，再按 range 交出连续的正文；超过这次调用剩下的预算就这一项失败，不回半份。 */
  private async readOne(
    item: FileReadItem,
    budgetChars: number,
    ctx: FileOperationContext
  ): Promise<FileText> {
    const { path, target, linked } = await this.locate(item.path, ctx)
    const span = isPresent(item.range) ? lineSpan(item.range) : null
    if (isPresent(item.range) && !span)
      throw new AppError(
        'VALIDATION',
        `range 要行号或 [首行, 末行]（从 1 起，末行不小于首行），这里给的是 ${JSON.stringify(item.range)}`
      )
    ctx.abortSignal.throwIfAborted()
    const buffer = await readBoundedFile(target, path, FileLimits.fileBytes)
    ctx.abortSignal.throwIfAborted()
    // 先认文本：内容恰好以 GIF8、%PDF- 开头的文本文件照样是文本；解不出文本的，再看是不是图片或文档，把该怎么办说清楚。
    const decoded = textCodec.decode(buffer)
    const media = decoded ? null : detectMediaType(buffer)
    if (media)
      throw new AppError(
        'VALIDATION',
        media.kind === 'image'
          ? `${path} 是图片，用 velaros:images 的 view 看`
          : `${path} 是 PDF，不是文本；文档不在这里读`
      )
    const { content, encoding } = decoded ?? decodeText(buffer, path)
    const text = splitLines(content)
    const [from, to] = span ?? [1, text.lines.length]
    if (span && from > Math.max(text.lines.length, 1))
      throw new AppError(
        'VALIDATION',
        `${path} 只有 ${text.lines.length} 行，range 从第 ${from} 行起`
      )
    const window = windowText(text, from, to)
    if (window.length > budgetChars) {
      throw new AppError(
        'VALIDATION',
        `${path} 要交回 ${window.length} 个字符，这次调用前面的文件已经用掉了大半预算，剩下 ${budgetChars}；把它单独放进一次 read，或者用 range 少读几行`
      )
    }
    return withLinkTarget<FileText>(
      { path, encoding, totalLines: text.lines.length, startLine: from, text: window },
      target,
      linked
    )
  }

  /** 把模型给的路径交给空间定下来：先规整特殊空白与开头的 `@`，不是字符串的直接拒绝。 */
  private locate(path: unknown, ctx: FileOperationContext): Promise<FileLocation> {
    if (!isString(path) || isBlank(path))
      return Promise.reject(new AppError('VALIDATION', '每一项都要有 path（字符串）'))
    return ctx.files.locate(this.platform.normalizeUserPathInput(path))
  }
}

/** 整个进程只有一份的文件操作；宿主把它挂在代码面的 `files` 命名空间上，每次调用时把自己空间的端口塞进 ctx。 */
export const fileOperations: FileOperationsApi = new FileOperations(
  currentPlatform,
  new FileChanges()
)
