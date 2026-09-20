import { createHash } from 'node:crypto'

import type { ContextReadStamp,ContextSourceCapabilities, ContextSourceHit, ContextSourcePort, ContextSourceRead, ContextTarget, ContextTaskScope, ContextTime, ContextViewForm } from '@velaros-ai/context'

import type { ProjectContextSourceOptions } from '../../contract/requires.js'
import type { Range } from '../../types/common.js'

/** 项目证据的读取口，路径、编码、符号与版本沿用项目内核。 */
export interface ProjectContextSourceApi extends ContextSourcePort {}

/** 当前项目只读证据适配器，写入仍经过项目事务。 */
export class ProjectContextSource implements ProjectContextSourceApi {
  public readonly id: string
  public readonly capabilities: ContextSourceCapabilities = { snapshot: false, revision: true, conditionalWrite: 'best-effort' }

  public constructor(private readonly options: ProjectContextSourceOptions) { this.id = options.id }

  public async authorize(scope: ContextTaskScope, target: ContextTarget, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (target.kind !== 'resource' || target.sourceId !== this.id || (this.options.sessionId && this.options.sessionId !== scope.sessionId)) return false
    try { await this.options.kernel.stat({ path: target.resourceId }); signal.throwIfAborted(); return true }
    catch { signal.throwIfAborted(); return false }
  }

  public async search(scope: ContextTaskScope, query: string, limit: number, signal: AbortSignal): Promise<readonly ContextSourceHit[]> {
    signal.throwIfAborted()
    if (this.options.sessionId && this.options.sessionId !== scope.sessionId) throw Object.assign(new Error('会话不在此证据源范围内'), { code: 'DENIED' })
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('候选查询上限无效')
    const result = await this.options.kernel.search({ query, maxResults: limit, regex: false })
    signal.throwIfAborted()
    return result.hits.slice(0, limit).map(hit => ({
      target: { kind: 'resource', sourceId: this.id, resourceId: hit.path, ...(hit.range ? { selector: { kind: 'lines', start: hit.range.startLine, end: hit.range.endLine } as const } : {}) },
      preview: (hit.snippet ?? '').slice(0, 500), forms: ['excerpt', 'full'],
    }))
  }

  public async read(scope: ContextTaskScope, target: ContextTarget, form: ContextViewForm, time: ContextTime, maxBytes: number, signal: AbortSignal): Promise<ContextSourceRead> {
    if (!await this.authorize(scope, target, signal) || target.kind !== 'resource') throw Object.assign(new Error('目标不在项目范围内'), { code: 'DENIED' })
    if (time.kind !== 'after-step') throw Object.assign(new Error('项目源提供当前版本；历史正文需使用已归档的材料引用'), { code: 'UNSUPPORTED_TIME' })
    const stat = await this.options.kernel.stat({ path: target.resourceId })
    if (!stat.exists || stat.kind !== 'file') throw Object.assign(new Error('文件不存在或不是文件'), { code: 'SOURCE_UNAVAILABLE' })
    if (!stat.readableText || stat.isBinary) throw Object.assign(new Error('此资源需要二进制或文档适配器'), { code: 'UNSUPPORTED_MEDIA' })
    let range: Partial<Range> | undefined
    if (target.selector?.kind === 'lines') range = { startLine: target.selector.start, endLine: target.selector.end }
    if (target.selector?.kind === 'symbol') {
      const name = target.selector.name
      const symbols = (await this.options.kernel.listSymbols(target.resourceId)).filter(symbol => symbol.name === name)
      if (symbols.length !== 1) throw Object.assign(new Error('符号不存在或不唯一，请提供精确范围'), { code: 'AMBIGUOUS_SYMBOL' })
      range = symbols[0]!.range
    }
    const result = form === 'metadata' ? null : await this.options.kernel.read({ path: target.resourceId, baseRevision: stat.revision ?? undefined, range, maxBytes, maxChars: maxBytes })
    signal.throwIfAborted()
    if (result && typeof result.content !== 'string') throw Object.assign(new Error('源没有返回文本正文'), { code: 'UNSUPPORTED_MEDIA' })
    const original = result?.content ?? JSON.stringify({ path: target.resourceId, revision: stat.revision, sizeBytes: stat.sizeBytes, textEncoding: stat.textEncoding, lineCount: stat.lineCount })
    let text = original
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      let bytes = 0; text = ''
      for (const point of original) { const length = Buffer.byteLength(point, 'utf8'); if (bytes + length > maxBytes) break; text += point; bytes += length }
    }
    const complete = text.length === original.length && !result?.truncated
    return {
      text, complete, form: complete ? form : 'excerpt', mediaType: 'text/plain',
      stamp: { sourceId: this.id, resourceId: target.resourceId, revision: result?.snapshot.revision ?? stat.revision, contentHash: createHash('sha256').update(text).digest('hex'), observedAt: new Date().toISOString(), consistency: 'revision-checkable' },
    }
  }

  public async validate(scope: ContextTaskScope, stamp: ContextReadStamp, signal: AbortSignal): Promise<'current' | 'changed' | 'unknown'> {
    if (!await this.authorize(scope, { kind: 'resource', sourceId: stamp.sourceId, resourceId: stamp.resourceId }, signal)) return 'changed'
    const stat = await this.options.kernel.stat({ path: stamp.resourceId })
    signal.throwIfAborted()
    return stat.revision && stat.revision === stamp.revision ? 'current' : 'changed'
  }
}

/** 为双核 Runtime 装配项目证据；正文与修改操作使用同一份项目版本权威。 */
export function createProjectContextSource(options: ProjectContextSourceOptions): ProjectContextSourceApi { return new ProjectContextSource(options) }
