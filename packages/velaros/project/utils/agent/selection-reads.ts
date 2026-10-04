/** 批量定位：正文连续展示，工具计算边界，歧义明确交给调用方选择。 */
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type { ProjectSourceCoordinates } from '../../types/editing.js'
import type { ProjectFileView } from '../../types/file-refs.js'
import type {
  ProjectSelectedSource,
  ProjectSelectionRecord,
  ProjectSelectIssue,
  ProjectSelectResult,
  ProjectStructureSpan,
} from '../../types/selection.js'
import {
  createProjectSourceCoordinates,
  logicalSourceOffset,
  physicalSourceOffset,
  sourceLineAt,
} from '../editing/source.js'
import { projectStructureSpans } from '../editing/structure-selection.js'
import { ProjectError } from '../errors.js'

import { readFiles } from './file-reads.js'
import { resolveFileRef } from './file-refs.js'
import { projectRelativePath } from './ports.js'
import { selectInput } from './selection-input.js'
import { loadSelection, saveSelection, selectionRef } from './selection-refs.js'

/** 定位失败保持原因码与下一步；取消或未知宿主故障不冒充普通缺口。 */
function issueAt(error: unknown, index: number): ProjectSelectIssue {
  if (error instanceof ProjectError) {
    const issue: ProjectSelectIssue = { index, code: error.reason, message: error.message }
    if (error.suggestedNextAction) issue.next = error.suggestedNextAction
    return issue
  }
  if (error instanceof AppError && ['PERMISSION', 'NOT_FOUND', 'VALIDATION'].includes(error.code))
    return {
      index,
      code: error.code === 'PERMISSION' ? 'PERMISSION_DENIED' : error.code,
      message: error.message,
    }
  throw error
}

/** 精确片段在已确认范围内的全部出现位置；换行等价但不放宽空白或 Unicode。 */
function matchSpans(
  source: ProjectSourceCoordinates,
  record: ProjectSelectionRecord,
  match: string
): ProjectStructureSpan[] {
  const needle = match.replace(/\r\n/gu, '\n')
  const end = logicalSourceOffset(source, record.end)
  const result: ProjectStructureSpan[] = []
  for (
    let at = source.logical.indexOf(needle, logicalSourceOffset(source, record.start));
    at >= 0 && at + needle.length <= end;
    at = source.logical.indexOf(needle, at + 1)
  ) {
    result.push({
      name: match,
      start: physicalSourceOffset(source, at),
      end: physicalSourceOffset(source, at + needle.length),
    })
    if (result.length > ProjectFileLimits.selectionCandidates) break
  }
  return result
}

/** 同一调用按源码身份复用坐标与语法解析，避免大量目标反复解析整份源码。 */
export async function selectSources(
  input: unknown,
  ctx: ProjectOperationContext
): Promise<ProjectSelectResult> {
  const requests = selectInput(input)
  const paths = new Map<
    string,
    Promise<{ record: ProjectSelectionRecord; view: ProjectFileView }>
  >()
  const scopes = new Map<
    string,
    Promise<{ record: ProjectSelectionRecord; view: ProjectFileView }>
  >()
  const coordinates = new Map<string, ProjectSourceCoordinates>()
  const structures = new Map<string, ProjectStructureSpan[]>()
  const targets: ProjectSelectedSource[] = []
  const issues: ProjectSelectIssue[] = []
  let chars = 0
  let sourceChars = 0
  for (const [index, request] of requests.entries()) {
    ctx.abortSignal.throwIfAborted()
    try {
      let bound: { record: ProjectSelectionRecord; view: ProjectFileView }
      if ('path' in request) {
        const path = await projectRelativePath(ctx, request.path)
        if (!paths.has(path) && paths.size >= ProjectFileLimits.selectFiles)
          throw new ProjectError(
            'SCOPE_VIOLATION',
            `一次最多定位 ${ProjectFileLimits.selectFiles} 个源码文件，请拆分目标。`
          )
        if (!paths.has(path))
          paths.set(
            path,
            (async () => {
              const [window] = (
                await readFiles(
                  { files: [{ path }] },
                  ctx,
                  ProjectFileLimits.readChars - sourceChars
                )
              ).files
              if (!window?.target)
                throw new ProjectError('NOT_SUPPORTED', '这个文件当前没有可编辑的完整源码版本。')
              return loadSelection(ctx, window.target)
            })()
          )
        bound = await paths.get(path)!
      } else {
        const ref = selectionRef(request.within)
        if (!scopes.has(ref))
          scopes.set(
            ref,
            (async () => {
              const loaded = await loadSelection(ctx, request.within)
              // within 只能基于仍然成立的旧视图派生目标，不能把陈旧源码再次展示成当前源码。
              return {
                record: loaded.record,
                view: await resolveFileRef(ctx, loaded.record.fileRef),
              }
            })()
          )
        bound = await scopes.get(ref)!
      }
      const { record, view } = bound
      const identity = `${view.path}:${view.contentRevision}`
      let source = coordinates.get(identity)
      if (!source) {
        if (
          coordinates.size >= ProjectFileLimits.selectFiles ||
          sourceChars + view.content.length > ProjectFileLimits.readChars
        )
          throw new ProjectError(
            'SCOPE_VIOLATION',
            `完整源码超过 ${ProjectFileLimits.selectFiles} 个文件或 ${ProjectFileLimits.readChars} 字符，请拆分目标。`
          )
        sourceChars += view.content.length
        source = createProjectSourceCoordinates(view.content)
        coordinates.set(identity, source)
      }
      let spans: ProjectStructureSpan[]
      if ('symbol' in request) {
        if (!structures.has(identity))
          structures.set(identity, projectStructureSpans(view.path, view.content))
        spans = structures
          .get(identity)!
          .filter(
            (span) =>
              (span.name === request.symbol ||
                (!request.symbol.includes('.') &&
                  span.name.split('.').at(-1) === request.symbol)) &&
              span.start >= record.start &&
              span.end <= record.end
          )
      } else spans = matchSpans(source, record, request.match)
      if (isEmpty(spans))
        throw new ProjectError(
          'TARGET_NOT_FOUND',
          '在指定范围内没有精确目标。',
          undefined,
          '核对声明全名或在更明确的可见范围内使用唯一 match。'
        )
      if (spans.length > ProjectFileLimits.selectionCandidates)
        throw new ProjectError(
          'SCOPE_VIOLATION',
          `目标超过 ${ProjectFileLimits.selectionCandidates} 个完整候选，请收窄作用域或限定声明名。`
        )
      const total = spans.reduce((sum, span) => sum + span.end - span.start, 0)
      if (chars + total > ProjectFileLimits.readChars)
        throw new ProjectError(
          'SCOPE_VIOLATION',
          `返回正文超过 ${ProjectFileLimits.readChars} 字符，请拆分目标。`
        )
      const found = spans.map((span): ProjectSelectedSource => {
        const selected: ProjectSelectedSource = {
          index,
          target: saveSelection(
            ctx,
            record.fileRef,
            view,
            span.start,
            span.end,
            'symbol' in request ? 'symbol' : 'text',
            'symbol' in request ? span.name : undefined,
            source
          ),
          startLine: sourceLineAt(source!, span.start),
          text: view.content.slice(span.start, span.end).replace(/\r\n/gu, '\n'),
        }
        if (spans.length > 1 && 'match' in request) {
          const first = Math.max(
            record.start,
            source!.lines[Math.max(0, selected.startLine - 2)].start
          )
          const endLine = sourceLineAt(source!, span.end)
          const last = Math.min(
            record.end,
            source!.lines[Math.min(source!.lines.length - 1, endLine)].end
          )
          selected.context = {
            startLine: sourceLineAt(source!, first),
            text: view.content.slice(first, last).replace(/\r\n/gu, '\n'),
          }
        }
        return selected
      })
      const delivered = found.reduce(
        (sum, item) => sum + item.text.length + (item.context?.text.length ?? 0),
        0
      )
      if (chars + delivered > ProjectFileLimits.readChars)
        throw new ProjectError(
          'SCOPE_VIOLATION',
          `返回正文超过 ${ProjectFileLimits.readChars} 字符，请拆分目标。`
        )
      chars += delivered
      if (found.length === 1) targets.push(found[0])
      else
        issues.push({
          index,
          code: 'AMBIGUOUS_TARGET',
          message: `找到 ${found.length} 个精确目标，请明确选择候选 target。`,
          candidates: found,
        })
      // @arch-guard:suspend code-style/require-error-logging 理由：已知领域异常转为 issues 回执；issueAt 将未知异常重抛。
    } catch (error) {
      issues.push(issueAt(error, index))
    }
  }
  const result: ProjectSelectResult = { targets }
  if (!isEmpty(issues)) result.issues = issues
  return result
}
