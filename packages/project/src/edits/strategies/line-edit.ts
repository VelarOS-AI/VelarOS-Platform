import { ProjectError } from '../../errors.js'
import type { ReplaceLinesOperation } from '../../types/edit.js'
import type { FileSnapshot } from '../../types/snapshot.js'

/** 只生成正文；授权、校验、磁盘提交与回滚仍由事务链执行。 */
function lineChange(
  snapshot: FileSnapshot,
  operation: ReplaceLinesOperation,
  lineOffsets: readonly number[],
): { start: number; end: number; replacement: string } {
  const { startLine, endLine, newLines, baseRevision } = operation
  if (
    !baseRevision ||
    baseRevision !== snapshot.revision ||
    snapshot.revision.startsWith('staged:')
  ) {
    throw new ProjectError(
      'BASE_REVISION_MISMATCH',
      `replace_lines 的行号必须绑定当前磁盘 revision：${snapshot.path}`,
      { path: snapshot.path, expected: baseRevision, actual: snapshot.revision },
      '请提交同文件的前序修改，再用 project:read 重读目标区域；使用返回的 snapshot.revision 和行号重新编辑。',
    )
  }
  if (
    !snapshot.exists ||
    snapshot.isDirectory ||
    snapshot.isBinary ||
    typeof snapshot.content !== 'string'
  ) {
    throw new ProjectError(
      'NOT_SUPPORTED',
      `replace_lines 需要完整可读的文本文件：${snapshot.path}`,
    )
  }
  const content = snapshot.content
  // 与 project:read 一致：末尾换行之后的空行也有行号。
  const totalLines = lineOffsets.length
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > totalLines
  ) {
    throw new ProjectError(
      'INVALID_INPUT',
      `replace_lines 范围 ${startLine}–${endLine} 超出有效行号 1–${totalLines}：${snapshot.path}`,
      { path: snapshot.path, startLine, endLine, totalLines },
      '请按 project:read 返回的行号选择范围；编辑范围不会自动钳制。',
    )
  }
  if (
    !Array.isArray(newLines) ||
    newLines.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))
  ) {
    throw new ProjectError(
      'INVALID_INPUT',
      'replace_lines.newLines 每项必须是一行字符串，不含 CR/LF。',
    )
  }
  const start = lineOffsets[startLine - 1]
  const end = lineOffsets[endLine] ?? content.length
  const selected = content.slice(start, end)
  const nearby = selected.includes('\n') ? selected : content.slice(0, start)
  const newline = nearby.match(/\r?\n/g)?.at(-1) ?? '\n'
  const replacement =
    newLines.join(newline) + (newLines.length > 0 && selected.endsWith('\n') ? newline : '')
  return { start, end, replacement }
}

export function replaceSnapshotLines(
  snapshot: FileSnapshot,
  operation: ReplaceLinesOperation,
): string {
  return replaceSnapshotLineRanges(snapshot, [operation])
}

/** 同一快照的多个不重叠范围一次拼接，调用方不需要计算前序编辑引起的行号位移。 */
export function replaceSnapshotLineRanges(
  snapshot: FileSnapshot,
  operations: readonly ReplaceLinesOperation[],
): string {
  const lineOffsets = [0]
  const content = snapshot.content ?? ''
  for (
    let offset = content.indexOf('\n');
    offset !== -1;
    offset = content.indexOf('\n', offset + 1)
  ) {
    lineOffsets.push(offset + 1)
  }
  const changes = operations
    .map((operation, rangeIndex) => {
      try {
        return { ...lineChange(snapshot, operation, lineOffsets), rangeIndex }
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error
        throw new ProjectError(
          error.reason,
          error.message,
          { ...error.details, rangeIndex },
          error.suggestedNextAction,
        )
      }
    })
    .sort((left, right) => right.start - left.start)
  for (let index = 1; index < changes.length; index += 1) {
    const previous = changes[index - 1]
    const current = changes[index]
    if (current.end > previous.start || current.start === previous.start) {
      throw new ProjectError('INVALID_INPUT', '同一文件的整行编辑范围重叠，请合并成一次替换。', {
        path: snapshot.path,
        rangeIndex: current.rangeIndex,
      })
    }
  }
  const pieces: string[] = []
  let cursor = 0
  for (const change of changes.reverse()) {
    pieces.push(content.slice(cursor, change.start), change.replacement)
    cursor = change.end
  }
  pieces.push(content.slice(cursor))
  return pieces.join('')
}
