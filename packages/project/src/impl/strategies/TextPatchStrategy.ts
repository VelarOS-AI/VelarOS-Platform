/**
 * 文本补丁策略：`TextPatchStrategy`，实现注入面的 `PatchStrategy`（contract/requires.ts）。
 * 优先级最低的兜底策略：文本锚点编辑（replace_text、insert_text_at_anchor、delete_text 等）、整行替换，
 * 以及文件的新建、删除、重命名。新文本的换行符跟随被替换的区域。
 */

import { isPresent, isString, isTrue, optionalWhen } from '@velaros-ai/core'

import type { PatchStrategy } from '../../contract/requires.js'
import type { CreateFileOperation, DeleteFileOperation, PreparedPatch, RenameFileOperation } from '../../types/edit.js'
import type { PatchStrategyInput } from '../../types/patch.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import { replaceSnapshotLines } from '../../utils/editing/line-edit.js'
import { assertFileTarget, createTextPatch, rebuildableContent, revertibleContent } from '../../utils/editing/prepared-patch.js'
import { lineEndingReference, replaceSelectedMatches, selectTextMatches } from '../../utils/editing/text-selection.js'
import { ProjectError } from '../../utils/errors.js'
import { adaptTextToContentLineEndings, includesLineEndingAware } from '../../utils/text.js'

export class TextPatchStrategy implements PatchStrategy {
  /** 本策略接的操作：文本锚点与整行编辑，外加文件的新建、删除、重命名。 */
  private static readonly HandledOperations: ReadonlySet<string> = new Set([
    'replace_text',
    'replace_lines',
    'insert_text',
    'insert_text_at_anchor',
    'append_text',
    'prepend_text',
    'delete_text',
    'create_file',
    'delete_file',
    'rename_file',
  ])

  public readonly id = 'core.text-patch'
  public readonly priority = 10

  public canHandle(input: PatchStrategyInput): boolean {
    return TextPatchStrategy.HandledOperations.has(input.intent.operation.type)
  }

  public prepare(input: PatchStrategyInput): PreparedPatch[] {
    const op = input.intent.operation
    if (op.type === 'create_file') return [this.createFilePatch(op, input.snapshot)]
    if (op.type === 'delete_file') return [this.deleteFilePatch(op, input.snapshot)]
    if (op.type === 'rename_file') return this.renameFilePatches(op, input.snapshot)

    const snap = input.snapshot
    if (!snap) {
      const pathHint =
        input.target?.path ?? ('path' in op ? op.path : undefined) ?? '(unknown path)'
      throw new ProjectError(
        'NOT_SUPPORTED',
        `text patch 需要已加载的文本 snapshot；当前操作没有可用 snapshot（路径提示：${pathHint}）。`,
        { operationType: op?.type, pathHint },
        '请确保操作能解析到文件路径或 targetId。先有界读取目标文件获取内容和 revision，再重新准备编辑事务。',
      )
    }
    if (snap.isBinary) {
      throw new ProjectError(
        'NOT_SUPPORTED',
        `text patch 不能编辑二进制文件（${snap.path}）。`,
        { path: snap.path },
        '请对二进制资源使用非文本工作流。',
      )
    }
    // 既有文件却没有正文，只能是超出读取上限：把原文当空串算补丁，apply 会把整份文件截成只剩新文本，
    // `oldContent: ""` 还会让回滚写出空文件。编辑必须建立在读到的原文上，读不到就拒绝。
    if (snap.exists && !isString(snap.content)) {
      throw new ProjectError(
        'NOT_SUPPORTED',
        `text patch 不能编辑超出读取上限的文件（${snap.path}，${snap.size} 字节）。`,
        {
          path: snap.path,
          size: snap.size,
          maxFileSizeToReadBytes: input.policy.maxFileSizeToReadBytes,
        },
        '请用项目命令处理这个大文件（例如 sed 或重定向追加），或先把它拆成较小的文件。',
      )
    }
    const content = snap.content ?? ''
    if (op.type === 'replace_lines')
      return [
        this.patch(snap.path, snap.revision, content, replaceSnapshotLines(snap, op), {
          op: 'replace_lines',
          startLine: op.startLine,
          endLine: op.endLine,
        }),
      ]
    let start = input.target?.range?.startOffset
    let end = input.target?.range?.endOffset

    if (op.type === 'replace_text') {
      let replacementText = op.newText
      if (op.oldText) {
        const selected = selectTextMatches(
          input,
          op,
          content,
          op.oldText,
          op.newText,
          'replace_text',
        )
        start = selected.indices[0]
        end = start + selected.matchedText.length
        replacementText = selected.replacementText ?? op.newText
        replacementText = adaptTextToContentLineEndings(
          lineEndingReference(content, selected.matchedText),
          replacementText,
        )
        // 针对已匹配文本窗口校验 anchors.mustContain。
        const anchors = op.anchors ?? input.target?.anchors
        if (anchors?.mustContain) {
          const window = content.slice(start, end)
          for (const required of anchors.mustContain) {
            if (!includesLineEndingAware(window, required)) {
              throw new ProjectError(
                'AMBIGUOUS_TARGET',
                `replace_text 的 mustContain 锚点不满足：匹配文本中未找到 "${required}"`,
                { required },
              )
            }
          }
        }
        const newContent = replaceSelectedMatches(
          content,
          selected.indices,
          selected.matchedText,
          replacementText,
        )
        return [
          this.patch(snap.path, snap.revision, content, newContent, {
            op: 'replace_text',
            startOffset: start,
            endOffset: end,
            matchedCount: selected.totalMatches,
            modifiedCount: selected.indices.length,
            matchNote: selected.matchNote,
          }),
        ]
      }
      if (!isPresent(start) || !isPresent(end)) {
        throw new ProjectError('TARGET_NOT_FOUND', 'replace_text 需要已解析目标范围或 oldText')
      }
      const replacedText = content.slice(start, end)
      replacementText = adaptTextToContentLineEndings(
        lineEndingReference(content, replacedText),
        replacementText,
      )
      const newContent = content.slice(0, start) + replacementText + content.slice(end)
      return [
        this.patch(snap.path, snap.revision, content, newContent, {
          op: 'replace_text',
          startOffset: start,
          endOffset: end,
        }),
      ]
    }

    if (op.type === 'insert_text') {
      if (!isPresent(start) || !isPresent(end))
        throw new ProjectError('TARGET_NOT_FOUND', 'insert_text 需要已解析目标范围')
      const at = op.position === 'before' ? start : end
      const insertionText = adaptTextToContentLineEndings(content, op.text)
      const newContent = content.slice(0, at) + insertionText + content.slice(at)
      return [
        this.patch(snap.path, snap.revision, content, newContent, {
          op: 'insert_text',
          startOffset: at,
          endOffset: at,
        }),
      ]
    }

    if (op.type === 'insert_text_at_anchor') {
      if (!op.anchorText)
        throw new ProjectError('INVALID_INPUT', 'insert_text_at_anchor 需要 anchorText')
      const selected = selectTextMatches(
        input,
        op,
        content,
        op.anchorText,
        op.text,
        'insert_text_at_anchor',
      )
      const insertionText = adaptTextToContentLineEndings(
        lineEndingReference(content, selected.matchedText),
        selected.replacementText ?? op.text,
      )
      if (
        op.skipIfAlreadyPresent &&
        (includesLineEndingAware(content, op.text) || content.includes(insertionText))
      )
        return [
          this.patch(snap.path, snap.revision, content, content, {
            op: 'insert_text_at_anchor',
            noop: true,
          }),
        ]
      const insertionOffsets = selected.indices.map((index) =>
        op.position === 'before' ? index : index + selected.matchedText.length,
      )
      const newContent = replaceSelectedMatches(content, insertionOffsets, '', insertionText)
      const at = insertionOffsets[0]
      return [
        this.patch(snap.path, snap.revision, content, newContent, {
          op: 'insert_text_at_anchor',
          anchorText: selected.matchedText,
          position: op.position,
          startOffset: at,
          endOffset: at,
          matchedCount: selected.totalMatches,
          modifiedCount: selected.indices.length,
          matchNote: selected.matchNote,
        }),
      ]
    }

    if (op.type === 'append_text') {
      const appendedText = adaptTextToContentLineEndings(content, op.text)
      const newContent =
        op.skipIfAlreadyPresent &&
        (includesLineEndingAware(content, op.text) || content.includes(appendedText))
          ? content
          : content + appendedText
      return [
        this.patch(snap.path, snap.revision, content, newContent, {
          op: 'append_text',
        }),
      ]
    }

    if (op.type === 'prepend_text') {
      const prependedText = adaptTextToContentLineEndings(content, op.text)
      const newContent =
        op.skipIfAlreadyPresent &&
        (includesLineEndingAware(content, op.text) || content.includes(prependedText))
          ? content
          : prependedText + content
      return [
        this.patch(snap.path, snap.revision, content, newContent, {
          op: 'prepend_text',
        }),
      ]
    }

    if (op.type === 'delete_text') {
      if (op.oldText) {
        const selected = selectTextMatches(
          input,
          op,
          content,
          op.oldText,
          undefined,
          'delete_text',
        )
        start = selected.indices[0]
        end = start + selected.matchedText.length
        const newContent = replaceSelectedMatches(
          content,
          selected.indices,
          selected.matchedText,
          '',
        )
        return [
          this.patch(snap.path, snap.revision, content, newContent, {
            op: 'delete_text',
            startOffset: start,
            endOffset: end,
            matchedCount: selected.totalMatches,
            modifiedCount: selected.indices.length,
            matchNote: selected.matchNote,
          }),
        ]
      }
      if (!isPresent(start) || !isPresent(end))
        throw new ProjectError('TARGET_NOT_FOUND', 'delete_text 需要已解析目标范围或 oldText')
      const newContent = content.slice(0, start) + content.slice(end)
      return [
        this.patch(snap.path, snap.revision, content, newContent, {
          op: 'delete_text',
          startOffset: start,
          endOffset: end,
        }),
      ]
    }

    throw new ProjectError('NOT_SUPPORTED', `不支持的文本操作：${op.type}`)
  }

  /**
   * `create_file` 的目标以事务暂存视图判定：本事务前面删掉的算不存在，前面刚创建的算已存在。
   * 覆盖既有文件时补丁带上原文与 revision——rollback 据此写回原文而不是删除文件，apply 前原文
   * 被外部改动则按 base revision 冲突拒绝。取不到原文（二进制/超限）时 oldContent 留空，
   * 由 rollback 预检整体拒绝，绝不把原文件截成空。
   */
  private createFilePatch(op: CreateFileOperation, snapshot: Optional<FileSnapshot>): PreparedPatch {
    const replaced = optionalWhen(isTrue(snapshot?.exists), snapshot)
    if (isPresent(replaced) && !isTrue(op.overwrite)) {
      throw new ProjectError(
        'TARGET_EXISTS',
        `目标文件已存在，create_file 未开启 overwrite，拒绝覆盖：${op.path}`,
        { path: op.path, actual: replaced.revision },
        '先读取现有文件；整文件替换需明确选择 overwrite 覆盖操作，局部修改需选择文本编辑操作。创建新文件请使用尚不存在的路径。',
      )
    }
    return this.patch(
      op.path,
      snapshot?.revision,
      isPresent(replaced) ? revertibleContent(replaced) : '',
      op.content,
      {
        op: 'create_file',
        overwrite: isTrue(op.overwrite),
        replacesExisting: isPresent(replaced),
      },
    )
  }

  /** 删除文件的补丁：原文能重建时记下它供回滚写回，否则 oldContent 缺席、按不可恢复处理。 */
  private deleteFilePatch(op: DeleteFileOperation, snapshot: Optional<FileSnapshot>): PreparedPatch {
    if (!snapshot?.exists)
      throw new ProjectError('TARGET_NOT_FOUND', `无法删除不存在的文件：${op.path}`)
    assertFileTarget(snapshot, 'delete_file')
    return this.patch(op.path, snapshot.revision, rebuildableContent(snapshot), '', {
      op: 'delete_file',
      textEncoding: snapshot.textEncoding,
    })
  }

  /**
   * 重命名按「新路径写入原文 + 删除旧路径」两个补丁完成，正文必须能在新路径上原样重建；
   * 二进制或超限文件取不到正文，照做会在新路径写下空文件并删掉原文件；符号链接会变成普通文件。
   */
  private renameFilePatches(op: RenameFileOperation, snapshot: Optional<FileSnapshot>): PreparedPatch[] {
    if (!snapshot?.exists)
      throw new ProjectError('TARGET_NOT_FOUND', `无法重命名不存在的文件：${op.from}`)
    assertFileTarget(snapshot, 'rename_file')
    const content = rebuildableContent(snapshot)
    if (!isString(content)) {
      throw new ProjectError(
        'NOT_SUPPORTED',
        `text patch 只能重命名能完整读取的普通文本文件，${snapshot.path} 是二进制、超出读取上限的文件或符号链接。`,
        { path: snapshot.path, to: op.to, isSymbolicLink: isTrue(snapshot.isSymbolicLink) },
        '请用项目命令移动该文件（例如 git mv 或 mv）。',
      )
    }
    // 两侧都记下原编码：新路径按它写出，回滚在原路径上按它重建。
    return [
      this.patch(op.from, snapshot.revision, content, '', {
        op: 'rename_file_delete',
        to: op.to,
        textEncoding: snapshot.textEncoding,
      }),
      this.patch(op.to, undefined, '', content, {
        op: 'rename_file_create',
        from: op.from,
        textEncoding: snapshot.textEncoding,
      }),
    ]
  }

  /** 以本策略的身份生成文本补丁。 */
  private patch(
    path: string,
    baseRevision: Optional<string>,
    oldContent: Optional<string>,
    newContent: string,
    metadata: Record<string, unknown>,
  ): PreparedPatch {
    return createTextPatch(path, baseRevision, oldContent, newContent, this.id, metadata)
  }
}
