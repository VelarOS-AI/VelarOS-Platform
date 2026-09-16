/**
 * 三个文件操作：`SystemFileOperations` 与整个进程唯一的 `systemFileOperations`。接口 `SystemFileOperationsApi` 在本文件的类上方。
 * `system:read`、`system:view`、`system:edit` 各调一个方法；三个都是一批文件（一个文件就一项），读和看里某个文件失败只标记它那一项、全部失败才整个报错，写是整批同成败；列目录和搜文本由 `system:run` 用系统命令做。PDF 与其他文档不在这里看。
 */

import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isArray, isEmpty, isNotNull, isNull, isPresent, Log, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'
import { currentPlatform } from '@velaros-ai/platform'
import { textCodec } from '@velaros-ai/text-files'
import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import { SystemFailureLimits, SystemFileLimits } from '../contract/constants.js'
import type { SystemToolContext } from '../contract/requires.js'
import type { SystemEditFileInput, SystemEditFileResult, SystemEditInput, SystemEditPlan, SystemEditProblem, SystemEditReplacedResult, SystemEditResult, SystemEditTarget, SystemEditWindow, SystemReadFileInput, SystemReadFileResult, SystemReadInput, SystemReadResult, SystemTextFileContent, SystemTextRange, SystemViewFileInput, SystemViewFileResult, SystemViewInput, SystemViewResult } from '../types/files.js'
import { assertFileBatchSize, failureEntry, staleProblem, unresolvedEditFailure, withLinkTarget } from '../utils/file-batch.js'
import { comparisonPath, confirmCredentialAccess, confirmSensitiveSystemMutation } from '../utils/file-safety.js'
import { readErrnoCode, writeSystemFileAtomically } from '../utils/fs.js'
import { adaptReplacementLineEndings, findOccurrences, lineEndingStyle, withLineEndingStyle } from '../utils/text.js'
import {
  clampTextRange,
  currentFileVersion,
  detectMediaType,
  fileVersionOf,
  readBoundedFile,
  readRawSystemFileBuffer,
  readSystemTextEncodingFromHead,
  readSystemTextFile,
  readTextWindow,
  reencodesExactly,
  stampOf,
  stampProvesUnchanged,
} from '../utils/text-file.js'
import { SystemTuning } from '../utils/tuning.js'

import type { SystemFileHistoryApi } from './SystemFileHistory.js'
import { SystemFileHistory } from './SystemFileHistory.js'

const log = Log.tag('SystemFileOperations')

/**
 * 三个文件操作：读文本、看图片与 PDF、写。`system:read`、`system:view`、`system:edit` 各调一个方法；列目录和搜文本由 `system:run` 用系统命令做。
 *
 * 实现是 `SystemFileOperations`，整个进程只有一份（`systemFileOperations`）。路径都按用户输入规整：`~` 展开到家目录，相对路径相对宿主给 system:run 的默认目录（宿主没给就相对家目录）。读凭证文件（私钥、云凭证、口令库）前先向用户确认。
 * 位置一律按字符算，没有行的概念。读写都保留原文件的编码（UTF-8、带 BOM、UTF-16、GB18030），认不出编码或有非法字节的按二进制处理；写先写临时文件、fsync 后原子替换，权限位原样保留；写系统敏感路径前先向用户确认，被拒绝就不动。
 */
export interface SystemFileOperationsApi {
  /**
   * 读文本文件，files 里每项一个，一个文件就一项，一批最多 20 项；返回与 files 一一对应的 files。
   * 每个文件按字符取一段：从 offset 起最多 maxChars 个（默认也是上限 20 万，尽量一次读完），返回这段的原文、它的 range 和内容的版本号，hasMore 时把 range.end 当下一次的 offset；不切开代理对。
   * 一次调用总共最多返回 20 万字符，按顺序分给各文件；预算用完后的文件不读盘，那一项换成失败条目，结果的 note 说明哪个文件被截短、从第几个起没读。路径是符号链接时读它指向的文件。
   * 给 version 就读改动前留下的那个版本，用来召回旧状态；版本只在本次运行的内存里留最近几份，找不到算这个文件失败。
   * 图片算失败并指向 view，PDF 算失败并说明文档不在这里读；其他二进制文件、目录、设备文件、超过 20 MB 的文件也算失败。
   * 某个文件失败只把它那一项换成失败条目，其余文件照常返回；全部失败时整个调用报错。
   */
  read(input: SystemReadInput, ctx: SystemToolContext): Promise<SystemReadResult>
  /**
   * 看图片，files 每项一个，一个文件就一项，一批最多 10 项；返回与 files 一一对应的 files，每张图整张作为模型可见的内容块按同样的顺序放在 modelContent 里交给模型，效果和用户上传一样，每块前面一行文字说明是哪个文件。
   * 只认模型本来就认得的 PNG、JPEG、GIF、WebP，没有字符上限，只有 5 MB 的字节上限，超过算失败让调用方先缩小。
   * PDF 和其他文档不在这里看；文本文件、其他二进制文件、目录、设备文件、超过 20 MB 的文件算失败。某个文件失败只把它那一项换成失败条目，全部失败时整个调用报错。
   */
  view(input: SystemViewInput, ctx: SystemToolContext): Promise<SystemViewResult>
  /**
   * 写文件，files 每项一个，一个文件就一项，一批最多 20 项；返回与 files 一一对应的 files。每项三种改法只用一种：
   * 只给 newText：把它当整个文件写进去，不存在就新建（连同上级目录），存在就覆盖。
   * 给 edits：在 read 读到的范围里改这几处（一次最多 50 处），每处在自己的 range 里改：给 oldText 就只换这段里唯一的那一处，不给就把整段换成 newText，空段就是插入。
   * 每项可以带 read 返回的 version：给了就先核对文件现在还是这个版本，被改过就整批不写，问题里给出当前版本。
   * 路径先解开符号链接：判重、审批、写入都按真正的那个文件，链接本身不会被换成普通文件，结果里 target 给出它；只给 newText 时已有的二进制文件拒改。
   * 一批全成或全不成：每个文件先过审批（系统敏感路径、凭证文件，第一次被拒就不再问后面的），再把所有改动在改动前的原文上定下来，写之前再核一次文件没变，最后按顺序写；定不下来或被拒就整批不写，
   * 抛出的错误 cause.details 里列出每个问题（第几个文件、第几处、原因；多处匹配带锚点，重叠标明另一处），context.executionOutcome 是 not-applied，调用方可以只改出问题的那一处再来一次。
   * 匹配只在各自的 range 里做，不在整个文件里找。
   * 只给 restore：把文件回到那个版本；回滚前的内容也留成一个版本，回滚本身能再回滚。
   * 每次改动前把原内容留成一个版本，结果里给出新版本号和改动前的版本号；改了几处的结果还返回每处新文本前后各 200 字符的小段，盖住所有改动那段不超过 2 万字符时整段也给，不用再读一遍确认。
   * edits 里写进去的文本跟着原文的换行风格走（看那一段，那一段没有换行就看整个文件）：CRLF 文件里的裸 LF 换成 CRLF；newText 整个写入原样写。
   * 沿用原编码，写不成原编码的新文本（孤立代理项、GB18030 表示不了的字符）整批不写。路径是管道、设备或套接字，或者文件有多个硬链接（原子替换会让它和其余链接分家）时不碰。写到一半出错原样报错，不标 not-applied，已写的文件在 context.applied 里点名。
   */
  edit(input: SystemEditInput, ctx: SystemToolContext): Promise<SystemEditResult>
}

class SystemFileOperations implements SystemFileOperationsApi {
  private readonly platform: PlatformCompatibilityApi
  private readonly history: SystemFileHistoryApi

  constructor(platformTools: PlatformCompatibilityApi, history: SystemFileHistoryApi) {
    this.platform = platformTools
    this.history = history
  }

  public async read(input: SystemReadInput, ctx: SystemToolContext): Promise<SystemReadResult> {
    assertFileBatchSize(input.files.length, SystemFileLimits.readFiles, 'read')
    const files: SystemReadResult['files'] = []
    const failures: AppError[] = []
    // 一次调用总共最多 readChars 个字符：按顺序分给每个文件；预算用完后的文件根本不读盘，那一项换成失败条目，note 说明从哪起。
    let remaining = SystemFileLimits.readChars
    let shortenedAt: Nullable<number> = null
    let exhaustedAt: Nullable<number> = null
    for (const [index, file] of input.files.entries()) {
      if (remaining <= 0) {
        if (isNull(exhaustedAt)) exhaustedAt = index
        files.push(failureEntry(file.path, new AppError('VALIDATION', `本次调用的 ${SystemFileLimits.readChars} 字符预算已被前面的文件用完，这个文件没有读；另起一次调用再读`)))
        continue
      }
      try {
        const requested = Math.min(SystemFileLimits.readChars, file.maxChars ?? SystemFileLimits.readChars)
        const result = await this.readOne(file, Math.min(requested, remaining), ctx)
        if (result.hasMore && remaining < requested && isNull(shortenedAt)) shortenedAt = index
        remaining -= result.content.length
        files.push(result)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one file in a read batch failed', { path: file.path, code: failure.code, message: failure.message })
        failures.push(failure)
        files.push(failureEntry(file.path, failure))
      }
    }
    if (failures.length === input.files.length) throw failures[0]
    const result: SystemReadResult = { files }
    const notes: string[] = []
    if (isNotNull(shortenedAt)) notes.push(`第 ${shortenedAt + 1} 个文件只拿到预算剩下的部分`)
    if (isNotNull(exhaustedAt)) notes.push(`从第 ${exhaustedAt + 1} 个文件起没有读`)
    if (!isEmpty(notes)) result.note = `一次调用最多 ${SystemFileLimits.readChars} 字符：${notes.join('，')}；把各自的 range.end 当 offset 再读一次，或分成几次调用。`
    return result
  }

  public async view(input: SystemViewInput, ctx: SystemToolContext): Promise<SystemViewResult> {
    assertFileBatchSize(input.files.length, SystemFileLimits.viewFiles, 'view')
    const files: SystemViewResult['files'] = []
    const modelContent: SystemViewResult['modelContent'] = []
    const failures: AppError[] = []
    for (const [index, file] of input.files.entries()) {
      try {
        const viewed = await this.viewOne(file, ctx)
        files.push(viewed.entry)
        modelContent.push({ type: 'text', text: `文件 ${index + 1}/${input.files.length}：${viewed.label}` }, viewed.part)
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('one file in a view batch failed', { path: file.path, code: failure.code, message: failure.message })
        failures.push(failure)
        files.push(failureEntry(file.path, failure))
      }
    }
    if (failures.length === input.files.length) throw failures[0]
    return { files, modelContent }
  }

  public async edit(input: SystemEditInput, ctx: SystemToolContext): Promise<SystemEditResult> {
    if (!isArray(input.files)) throw new AppError('VALIDATION', '缺少 files：每个要写的文件一项')
    assertFileBatchSize(input.files.length, SystemFileLimits.editFiles, 'edit')
    // 第一段：每个文件按解开符号链接后的真实路径判重、过审批（敏感路径、凭证文件），再把每一处定下来，什么都不写；
    // 有任何问题就整批失败，问题全部列出来让调用方一次改完。第一次被拒就停：这一批注定不写，不再为后面的文件打扰用户。
    const plans: SystemEditPlan[] = []
    const problems: SystemEditProblem[] = []
    const seen = new Set<string>()
    for (const [index, file] of input.files.entries()) {
      const resolvedPath = this.resolvePath(file.path, ctx)
      const target = await resolveRealPath(resolvedPath)
      const identity = comparisonPath(target, process.platform)
      if (seen.has(identity)) {
        problems.push({ file: index, path: resolvedPath, reason: 'invalid', message: '同一个文件在这一批里出现了不止一次（写法不同、经符号链接指向同一个文件的也算）；把它的改动合进一项' })
        continue
      }
      seen.add(identity)
      try {
        await confirmSensitiveSystemMutation(ctx, target, isPresent(file.edits) ? 'edit' : 'write')
        await confirmCredentialAccess(ctx, target, 'write')
      } catch (error) {
        const failure = AppError.from(error)
        log.debug('sensitive path write was not approved', { path: target, code: failure.code })
        problems.push({ file: index, path: resolvedPath, reason: 'denied', message: failure.message })
        break
      }
      const planned = await this.planOne(index, resolvedPath, target, file)
      if (isArray(planned)) problems.push(...planned)
      else plans.push(planned)
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)
    // 审批期间文件可能又被别人改了：写之前再 stat 一次，印记没变的大文件不重读，其余重读核版本；变了就整批不写。
    for (const plan of plans) {
      const now = stampOf(await stat(plan.target).catch(() => null))
      if (stampProvesUnchanged(plan.stamp, now)) continue
      const current = await currentFileVersion(plan.target)
      if (current !== plan.baseVersion) {
        problems.push({ file: plan.index, path: plan.path, reason: 'stale', message: '等用户确认期间文件被改过了；重新读一遍再改', currentVersion: toOptional(current) })
      }
    }
    if (!isEmpty(problems)) throw unresolvedEditFailure(problems)
    // 第二段：按顺序写。写到一半出错就原样抛出，不标 not-applied，前面已写的文件在 context 里点名。
    const files: SystemEditFileResult[] = []
    for (const plan of plans) {
      try {
        files.push(withLinkTarget(await this.applyOne(plan), plan.path, plan.target))
      } catch (error) {
        throw new AppError(AppError.from(error).code, `前 ${files.length} 个文件已经写入，files[${plan.index}] ${plan.path} 写入失败：${AppError.from(error).message}`, error, { applied: files.map((file) => file.path) })
      }
    }
    return { files }
  }

  /** 把一个文件的改法定下来但不写：返回写入计划，或者这个文件的问题清单。文件系统操作都对 target（真实路径），回执里的路径用 resolvedPath。 */
  private async planOne(index: number, resolvedPath: string, target: string, file: SystemEditFileInput): Promise<SystemEditPlan | SystemEditProblem[]> {
    const problem = (message: string, extra: Partial<SystemEditProblem> = {}): SystemEditProblem[] => [{ file: index, path: resolvedPath, reason: 'invalid', message, ...extra }]
    const restoring = isPresent(file.restore)
    const wholeFile = isPresent(file.newText)
    const editing = isPresent(file.edits)
    const modes = [restoring, wholeFile, editing].filter(Boolean).length
    if (modes === 0) return problem('给 newText 整个写入、给 edits 改其中几处，或者给 restore 回滚，三者选一')
    if (modes > 1) return problem('newText、edits、restore 只能用一种')
    const existing = await stat(target).catch(() => null)
    if (existing?.isDirectory()) return problem(`路径是目录，不是文件：${resolvedPath}`)
    // 管道、设备、套接字：读它可能永远等不到数据（读命名管道会一直挂着），整个替换又会把它换成普通文件，一律不碰。
    if (existing && !existing.isFile()) return problem(`路径不是普通文件（管道、设备或套接字），不能当文本改：${resolvedPath}`)
    // 原子替换是写一个新文件再改名：多个硬链接的文件换完就和其余链接分家了，一律不碰。
    if (existing && existing.nlink > 1) return problem(`文件有 ${existing.nlink} 个硬链接，原子替换会让它和其余链接分家，不能在这里改：${resolvedPath}；用 system:run 改`)
    const stamp = stampOf(existing)
    // 父路径已经存在却不是目录，写入注定失败，在计划期就报出来（缺失的父目录写的时候会补建）。
    const parentCode = await stat(dirname(target)).then((parent) => (parent.isDirectory() ? null : 'ENOTDIR')).catch((error: unknown) => readErrnoCode(error))
    if (parentCode === 'ENOTDIR') return problem(`上级路径不是目录：${dirname(target)}`)

    if (isPresent(file.restore)) {
      const snapshot = this.history.recall(target, file.restore)
      if (!snapshot) return problem(`历史里没有版本 ${file.restore}：只有本次运行里改动前留下的最近几份，而且只在内存里`, { reason: 'not-found' })
      // 回滚后的字符数在计划期就算好：认不出是文本的版本在这里就拒，不会写完了才报错。
      const restored = textCodec.decode(snapshot.buffer)
      if (!restored) return problem(`版本 ${file.restore} 不是能认出的文本（二进制、非法字节或认不出的编码），不能在这里回滚`)
      if (existing?.isFile() && existing.size > SystemFileLimits.fileBytes) return problem(`现有文件太大，不能在这里回滚覆盖：${existing.size} 字节，上限 ${SystemFileLimits.fileBytes} 字节`)
      const current = existing?.isFile() ? await readRawSystemFileBuffer(target) : null
      const baseVersion = current ? fileVersionOf(current) : null
      const stale = staleProblem(file.version, baseVersion)
      if (stale) return problem(stale.message, stale)
      return { kind: 'restore', index, path: resolvedPath, target, current, snapshot, totalChars: restored.content.length, baseVersion, stamp }
    }

    if (isPresent(file.newText)) {
      if (file.newText.includes('\0')) return problem('newText 里有 NUL 字节，是二进制数据，不能当文本写入')
      if (existing?.isFile() && existing.size > SystemFileLimits.fileBytes) return problem(`现有文件太大，不能在这里整个覆盖：${existing.size} 字节，上限 ${SystemFileLimits.fileBytes} 字节；用 system:run 替换`)
      let previous: Nullable<SystemTextFileContent> = null
      let encoding: TextEncoding = 'utf8'
      if (existing?.isFile()) {
        // 已有的文件必须是文本才许整个覆盖：二进制文件被 newText 盖掉就没了，也留不下能回滚的版本。
        // 不超过可编辑上限的整个读进来留版本；更大的留不下版本，只读开头一段认编码、拒二进制。
        try {
          if (existing.size <= SystemFileLimits.editableBytes) {
            previous = await readSystemTextFile(target)
            encoding = previous.encoding
          } else {
            encoding = await readSystemTextEncodingFromHead(target)
          }
        } catch (error) {
          const failure = AppError.from(error)
          log.debug('an existing file cannot be overwritten as text', { path: target, code: failure.code })
          return problem(`现有文件不能按文本重写（${failure.message}）；二进制文件用 system:run 替换`, { reason: failure.code === 'PERMISSION' ? 'denied' : 'invalid' })
        }
      }
      // 按原编码写不出来（孤立代理项、GB18030 表示不了的字符）就是这个文件的问题，整批不写，不静默换成替换字符或别的编码。
      let bytes: Buffer
      try {
        bytes = textCodec.encode(file.newText, encoding)
      } catch (error) {
        return problem(`newText 不能按 ${encoding} 无损写进这个文件：${AppError.from(error).message}`)
      }
      const baseVersion = previous ? fileVersionOf(previous.buffer) : existing?.isFile() ? await currentFileVersion(target) : null
      const stale = staleProblem(file.version, baseVersion)
      if (stale) return problem(stale.message, stale)
      return { kind: 'write', index, path: resolvedPath, target, created: !existing, previous, newText: file.newText, bytes, baseVersion, stamp }
    }

    const edits = file.edits ?? []
    if (isEmpty(edits)) return problem('edits 是空的；至少给一处要改的地方')
    if (edits.length > SystemFileLimits.editsPerFile) return problem(`一个文件一次最多改 ${SystemFileLimits.editsPerFile} 处，这里给了 ${edits.length} 处；分几次改`)
    if (!existing) return problem(`文件不存在：${resolvedPath}`, { reason: 'not-found' })
    if (existing.size > SystemFileLimits.editableBytes) return problem(`文件太大，不能用 edits 改：${existing.size} 字节，上限 ${SystemFileLimits.editableBytes} 字节；用 system:run 改`)
    let textFile: SystemTextFileContent
    try {
      textFile = await readSystemTextFile(target)
    } catch (error) {
      const failure = AppError.from(error)
      log.debug('a file in an edit batch could not be read', { path: target, code: failure.code })
      return problem(failure.message, { reason: failure.code === 'NOT_FOUND' ? 'not-found' : failure.code === 'PERMISSION' ? 'denied' : 'invalid' })
    }
    const baseVersion = fileVersionOf(textFile.buffer)
    const stale = staleProblem(file.version, baseVersion)
    if (stale) return problem(stale.message, stale)
    // 解码再编码必须得到原来的字节，否则改动区间之外的字节也会被改写；这种文件让 system:run 去改。
    if (!reencodesExactly(textFile)) return problem(`文件里有按 ${textFile.encoding} 解码再编码得不到原样的字节，改写会连带改掉没动的地方；用 system:run 改`)
    const content = textFile.content
    const fileStyle = lineEndingStyle(content)

    // 每一处都在改动前的原文上定目标；多处匹配给锚点，找不到、重叠也都记下来，一次报完。
    const problems: SystemEditProblem[] = []
    const targets: SystemEditTarget[] = []
    const scopes: SystemTextRange[] = []
    for (const [edit, change] of edits.entries()) {
      const at = (message: string, extra: Partial<SystemEditProblem> = {}): void => { problems.push({ file: index, path: resolvedPath, reason: 'invalid', message, edit, ...extra }) }
      if (change.newText.includes('\0')) { at('newText 里有 NUL 字节，是二进制数据，不能当文本写入'); continue }
      const lone = textCodec.findLoneSurrogate(change.newText)
      if (lone) { at(`newText 在 UTF-16 offset ${lone.offset} 是不完整的 Unicode 字符（孤立代理项），写不进文件；重新构造完整的字符`); continue }
      if (change.range.end < change.range.offset) { at(`range ${change.range.offset}-${change.range.end} 是反的：end 不能小于 offset`); continue }
      // 起点已经落在文件外，说明位置来自过期的内容；终点越界只是读到的段比现在长，收进文件长度即可。
      if (change.range.offset > content.length) {
        at(`range 从 ${change.range.offset} 开始，但文件只有 ${content.length} 个字符；重新读一遍`, { reason: 'stale', currentVersion: baseVersion })
        continue
      }
      const scope = clampTextRange(content, change.range)
      scopes.push(scope)
      const scopeText = content.slice(scope.offset, scope.end)
      // 写进去的新文本跟着原文的换行风格走：看这一段，这一段里没有换行就看整个文件。
      const style = lineEndingStyle(scopeText) ?? fileStyle
      if (!isPresent(change.oldText)) { targets.push({ edit, range: scope, newText: withLineEndingStyle(change.newText, style) }); continue }
      if (isEmpty(change.oldText)) { at('oldText 是空的；要整段替换就不给 oldText'); continue }
      const replacement = adaptReplacementLineEndings(scopeText, change.oldText, change.newText, style)
      // 只需要知道唯一不唯一和前 SystemFailureLimits.listItems 个锚点，多找一个就停，大文件里的短 oldText 不会扫出百万个匹配。
      const matches = findOccurrences(content, replacement.oldText, scope, SystemFailureLimits.listItems + 1)
      if (isEmpty(matches)) { at(`在 range ${scope.offset}-${scope.end} 里没找到 oldText；重新读这一段`, { reason: 'not-found' }); continue }
      if (matches.length > 1) {
        const count = matches.length > SystemFailureLimits.listItems ? `至少匹配到 ${matches.length} 处` : `匹配到 ${matches.length} 处`
        at(`oldText 在 range ${scope.offset}-${scope.end} 里${count}；从 anchors 里挑一处，把它的 range 填到这里`, {
          reason: 'ambiguous',
          matchCount: matches.length,
          anchors: matches.slice(0, SystemFailureLimits.listItems).map((offset) => {
            const range = { offset, end: offset + replacement.oldText.length }
            const around = clampTextRange(content, { offset: range.offset - SystemTuning.files.anchorContextChars, end: range.end + SystemTuning.files.anchorContextChars })
            return { range, context: content.slice(around.offset, around.end) }
          }),
        })
        continue
      }
      targets.push({ edit, range: { offset: matches[0]!, end: matches[0]! + replacement.oldText.length }, newText: replacement.newText })
    }
    const ordered = [...targets].sort((a, b) => a.range.offset - b.range.offset || a.range.end - b.range.end)
    for (let i = 1; i < ordered.length; i += 1) {
      const before = ordered[i - 1]!
      const after = ordered[i]!
      const overlapping = after.range.offset < before.range.end || (after.range.offset === before.range.offset && before.range.end === before.range.offset && after.range.end === after.range.offset)
      if (overlapping) problems.push({ file: index, path: resolvedPath, reason: 'overlap', message: `edits[${before.edit}] 和 edits[${after.edit}] 重叠；合成一处`, edit: after.edit, with: before.edit })
    }
    if (!isEmpty(problems)) return problems
    // 改完的正文与要写的字节在计划期就定下来：从后往前套用，前面的位置不受后面改动影响；按原编码写不出来就是这个文件的问题。
    let updated = content
    for (const target of [...ordered].reverse()) {
      updated = updated.slice(0, target.range.offset) + target.newText + updated.slice(target.range.end)
    }
    let bytes: Buffer
    try {
      bytes = textCodec.encode(updated, textFile.encoding)
    } catch (error) {
      return problem(`改完的文本不能按 ${textFile.encoding} 无损写进这个文件：${AppError.from(error).message}`)
    }
    return { kind: 'edits', index, path: resolvedPath, target, textFile, ordered, scopes, updated, bytes, baseVersion, stamp }
  }

  /** 按计划写一个文件：一律写到 target（真实路径），改动前把原内容留成一个版本，版本历史也按真实路径记。 */
  private async applyOne(plan: SystemEditPlan): Promise<SystemEditFileResult> {
    if (plan.kind === 'restore') {
      const previousVersion = plan.current ? this.history.remember(plan.target, plan.current) : null
      await mkdir(dirname(plan.target), { recursive: true })
      await writeSystemFileAtomically(plan.target, plan.snapshot.buffer)
      return { path: plan.path, action: 'restored', version: plan.snapshot.version, previousVersion, bytes: plan.snapshot.buffer.byteLength, totalChars: plan.totalChars }
    }
    if (plan.kind === 'write') {
      const previousVersion = plan.previous ? this.history.remember(plan.target, plan.previous.buffer) : null
      await mkdir(dirname(plan.target), { recursive: true })
      await writeSystemFileAtomically(plan.target, plan.bytes)
      return { path: plan.path, action: 'written', created: plan.created, version: fileVersionOf(plan.bytes), previousVersion, bytes: plan.bytes.byteLength, totalChars: plan.newText.length }
    }
    const { updated, bytes: buffer } = plan
    const previousVersion = this.history.remember(plan.target, plan.textFile.buffer)
    await writeSystemFileAtomically(plan.target, buffer)
    // 改完每处都交回新文本前后各一小段；盖住所有改动那段（各处 range 的并集）不长时整段也给，位置按改动前后的长度差挪。
    const windows: SystemEditWindow[] = []
    let shift = 0
    for (const target of plan.ordered) {
      const start = target.range.offset + shift
      const end = start + target.newText.length
      const around = clampTextRange(updated, { offset: start - SystemFileLimits.editContextChars, end: end + SystemFileLimits.editContextChars })
      windows.push({ edit: target.edit, range: around, content: updated.slice(around.offset, around.end) })
      shift += target.newText.length - (target.range.end - target.range.offset)
    }
    windows.sort((a, b) => a.edit - b.edit)
    const union = clampTextRange(updated, { offset: Math.min(...plan.scopes.map((scope) => scope.offset)), end: Math.max(...plan.scopes.map((scope) => scope.end)) + shift })
    const result: SystemEditReplacedResult = {
      path: plan.path,
      action: 'replaced',
      edits: plan.ordered.length,
      version: fileVersionOf(buffer),
      previousVersion,
      bytes: buffer.byteLength,
      totalChars: updated.length,
      windows,
    }
    if (union.end - union.offset <= SystemFileLimits.editWholeChars) {
      result.content = updated.slice(union.offset, union.end)
      result.range = union
    }
    return result
  }

  /** 读一个文件：按字符取最多 maxChars 个（调用方已把总预算算进去）；给 version 就读改动前留下的那个版本。符号链接按它指向的文件读，版本历史也按那个文件记。 */
  private async readOne(file: SystemReadFileInput, maxChars: number, ctx: SystemToolContext): Promise<SystemReadFileResult> {
    const resolvedPath = this.resolvePath(file.path, ctx)
    const target = await resolveRealPath(resolvedPath)
    await confirmCredentialAccess(ctx, target, 'read')
    if (isPresent(file.version)) {
      const snapshot = this.history.recall(target, file.version)
      if (!snapshot) {
        throw new AppError('NOT_FOUND', `历史里没有 ${resolvedPath} 的版本 ${file.version}：只有本次运行里改动前留下的最近几份，而且只在内存里`)
      }
      return readTextWindow(resolvedPath, snapshot.buffer, file.offset ?? 0, maxChars)
    }
    const buffer = await readBoundedFile(target, SystemFileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media) {
      throw new AppError('VALIDATION', media.kind === 'image' ? `${resolvedPath} 是图片，用 system:view 看` : `${resolvedPath} 是 PDF，不是文本；文档不在这里读`)
    }
    return readTextWindow(resolvedPath, buffer, file.offset ?? 0, maxChars)
  }

  /** 看一张图片：整张作为内容块交给模型，返回元数据、内容块和一行说明；不是模型认得的图片就报错。 */
  private async viewOne(file: SystemViewFileInput, ctx: SystemToolContext): Promise<{ entry: SystemViewFileResult; part: SystemViewResult['modelContent'][number]; label: string }> {
    const resolvedPath = this.resolvePath(file.path, ctx)
    const target = await resolveRealPath(resolvedPath)
    await confirmCredentialAccess(ctx, target, 'read')
    const buffer = await readBoundedFile(target, SystemFileLimits.fileBytes)
    const media = detectMediaType(buffer)
    if (media?.kind !== 'image') {
      throw new AppError('VALIDATION', media
        ? `${resolvedPath} 是 PDF；这个工具只看图片，文档不在这里读`
        : `${resolvedPath} 不是模型能看的图片（PNG、JPEG、GIF、WebP）；文本文件用 system:read，别的格式先转换`)
    }
    if (buffer.byteLength > SystemFileLimits.imageBytes) {
      throw new AppError('VALIDATION', `图片太大，不能交给模型：${buffer.byteLength} 字节，上限 ${SystemFileLimits.imageBytes} 字节；先用 system:run 缩小`)
    }
    return {
      entry: { path: resolvedPath, mediaType: media.mediaType, bytes: buffer.byteLength },
      part: { type: 'image-data', data: buffer.toString('base64'), mediaType: media.mediaType },
      label: resolvedPath,
    }
  }

  /** 把用户输入的路径变成绝对路径：规整特殊空格与开头的 `@`，`~` 和相对路径都交给宿主按它的家目录与默认工作目录解析。 */
  private resolvePath(path: string, ctx: SystemToolContext): string {
    return ctx.system.resolvePath(this.platform.normalizeUserPathInput(path))
  }
}

/** 整个进程只有一份的文件操作，按当前进程的平台规整路径。 */
export const systemFileOperations: SystemFileOperationsApi = new SystemFileOperations(currentPlatform, new SystemFileHistory())
