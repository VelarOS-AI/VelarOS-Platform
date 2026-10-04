import { isNull, isUndefined } from '@velaros-ai/core'
import { isArray, isEmpty, isString } from '@velaros-ai/core'

import { ContextLimits } from '../contract/constants.js'
import type { ContextRuntimeOptions } from '../contract/requires.js'
import type {
  ContextAppend,
  ContextContent,
  ContextInputSummary,
  ContextProjection,
  ContextQuery,
  ContextReadRange,
  ContextRecord,
  ContextRef,
  ContextSearchPage,
  ContextSnapshot,
  ContextState,
  ContextUserInput,
  NoteWrite,
  WorkingSetChange,
  WorkingSetCommit,
} from '../types/context.js'
import {
  boundedInteger,
  contextFailure,
  emptyContextState,
  sameContextRef,
} from '../utils/state.js'

import { createContextReference } from './ContextReferenceAllocator.js'

/** 会话的上下文权威。 */
export interface ContextRuntime {
  /** 保存原始用户输入，超大文本分块归档，附件保留引用。 */
  ingest(input: ContextUserInput, signal?: AbortSignal): Promise<ContextRecord>
  /** 分页读取原始用户输入；不会读入同会话的其他审计记录。 */
  readInput(ref: ContextRef, range?: ContextReadRange): Promise<ContextContent>
  /** 按版本保存理解结果，原文始终保留，摘要是模型解释。 */
  summarizeInput(input: ContextInputSummary, signal?: AbortSignal): Promise<ContextRef>
  /** 为真实目标生成有界正文或摘要，保留可召回元数据。 */
  projectInput(ref: ContextRef, maxChars: number, original?: boolean): Promise<ContextContent>

  /** 查看当前工作集和始终保留的最新用户输入。 */
  inspect(): Promise<ContextSnapshot>
  /** 检索当前会话的材料与原始记录。 */
  search(query: ContextQuery): Promise<ContextSearchPage>
  /** 有界读取原始正文，来源元数据不能被笔记改写。 */
  read(ref: ContextRef, range?: ContextReadRange): Promise<ContextContent>
  /** 模型写入带来源的工作材料。 */
  write(note: NoteWrite, signal?: AbortSignal): Promise<ContextRecord>
  /** 原子替换模型管理区；新事件总是保留。 */
  replace(change: WorkingSetChange, signal?: AbortSignal): Promise<WorkingSetCommit>
  /** 宿主追加原始事件，模型标准库不暴露此方法。 */
  append(input: ContextAppend, signal?: AbortSignal): Promise<ContextRecord>
  /** 冻结下一次请求的材料；超预算明确失败，不隐式压缩。 */
  project(maxChars: number): Promise<ContextProjection>
  /** 构建明确有界的恢复视图；原始正文通过引用分页读取。 */
  recover(maxChars: number): Promise<ContextProjection>
}

/** 上下文的单一会话视图；并发提交由存储端口的 CAS 保证。 */
export class SessionContext implements ContextRuntime {
  public constructor(private readonly options: ContextRuntimeOptions) {
    if (/^\["kernel-invocation(?:-index)?",/.test(options.sessionId))
      throw contextFailure('INVALID_SESSION', '会话身份使用了内部保留范围。')
    if (!options.sessionId.trim()) throw contextFailure('INVALID_SESSION', '会话标识不能为空。')
  }
  private async state(): Promise<ContextState> {
    return (await this.options.storage.load(this.options.sessionId)) ?? emptyContextState()
  }
  private record(state: ContextState, ref: ContextRef): ContextRecord {
    if (ref.sessionId !== this.options.sessionId)
      throw contextFailure('SCOPE_MISMATCH', '引用不在本会话作用域内。')
    const record = state.records.find((item) => sameContextRef(item.ref, ref))
    if (!record) throw contextFailure('REF_NOT_FOUND', '原始记录不存在。')
    return record
  }
  private async reference(ref: ContextRef): Promise<ContextRecord> {
    if (ref.sessionId !== this.options.sessionId)
      throw contextFailure('SCOPE_MISMATCH', '引用不在本会话作用域内。')
    const storage = this.options.storage
    if (!storage.records && !storage.selectSnapshot) return this.record(await this.state(), ref)
    const records = storage.records
      ? (await storage.records(this.options.sessionId, { refId: ref.id, limit: 1 })).items
      : ((await storage.selectSnapshot!(this.options.sessionId, [{ refId: ref.id }]))?.records ??
        [])
    const record = records.find((item) => sameContextRef(item.ref, ref))
    if (!record) throw contextFailure('REF_NOT_FOUND', '上下文引用不存在。')
    return record
  }
  public async inspect(): Promise<ContextSnapshot> {
    const state = await this.state()
    const latest = [...state.records].reverse().find((record) => record.kind === 'user')
    return {
      revision: state.workingSet.revision,
      cursor: state.records.length,
      items: state.workingSet.items,
      protected: latest ? [latest.ref] : [],
    }
  }
  public async append(input: ContextAppend, signal?: AbortSignal): Promise<ContextRecord> {
    signal?.throwIfAborted()
    if (!isString(input.body) || input.body.length > ContextLimits.objectChars)
      throw contextFailure('OBJECT_TOO_LARGE', '正文必须在单对象上限以内。')
    const ref = await createContextReference(this.options.storage, this.options.sessionId)
    const objectId = await this.options.storage.put(this.options.sessionId, input.body)
    const entry = {
      ref,
      kind: input.kind,
      title: input.title ?? '',
      objectId,
      chars: input.body.length,
      sources: input.sources ?? [],
      createdAt: new Date().toISOString(),
    }
    signal?.throwIfAborted()
    if (this.options.storage.appendRecord)
      return this.options.storage.appendRecord(this.options.sessionId, entry)
    for (;;) {
      const state = await this.state()
      for (const source of input.sources ?? []) this.record(state, source)
      const record: ContextRecord = {
        ...entry,
        sequence: (state.records.at(-1)?.sequence ?? 0) + 1,
      }
      signal?.throwIfAborted()
      if (
        await this.options.storage.compareAndSwap(this.options.sessionId, state.version, {
          ...state,
          version: state.version + 1,
          records: [...state.records, record],
        })
      )
        return record
    }
  }
  public async ingest(input: ContextUserInput, signal?: AbortSignal): Promise<ContextRecord> {
    if (!isUndefined(input.text) && !isString(input.text))
      throw contextFailure('INPUT_SCHEMA', '用户文字必须为字符串')
    for (const file of input.files ?? []) {
      await this.reference(file.ref)
      if (
        !file.name ||
        file.name.length > 1000 ||
        !file.mediaType ||
        (!isUndefined(file.bytes) && (!Number.isSafeInteger(file.bytes) || file.bytes < 0))
      )
        throw contextFailure('INPUT_SCHEMA', '文件引用元数据无效')
    }
    const text = input.text ?? ''
    if (!input.files?.length && text.length <= ContextLimits.objectChars)
      return this.append({ kind: 'user', body: text }, signal)
    const chunks: ContextRef[] = []
    for (let offset = 0; offset < text.length; offset += ContextLimits.objectChars)
      chunks.push(
        (
          await this.append(
            {
              kind: 'audit',
              title: 'user:text-chunk',
              body: text.slice(offset, offset + ContextLimits.objectChars),
            },
            signal
          )
        ).ref
      )
    return this.append(
      {
        kind: 'user',
        title: 'user:manifest',
        body: JSON.stringify({ chars: text.length, chunks, files: input.files ?? [] }),
        sources: [...chunks, ...(input.files ?? []).map((file) => file.ref)],
      },
      signal
    )
  }

  public async readInput(ref: ContextRef, range: ContextReadRange = {}): Promise<ContextContent> {
    const original = await this.reference(ref)
    const raw = await this.read(ref, original.title === 'user:manifest' ? { limit: 1 } : range)
    if (raw.record.kind !== 'user') {
      const storage = this.options.storage
      const records = storage.selectSnapshot
        ? ((
            await storage.selectSnapshot(this.options.sessionId, [
              { kind: 'user', title: 'user:manifest' },
            ])
          )?.records ?? [])
        : (await this.state()).records
      let file = false
      for (const manifest of records.filter(
        (item) =>
          item.kind === 'user' &&
          item.title === 'user:manifest' &&
          item.sources.some((source) => sameContextRef(source, ref))
      )) {
        const body = await storage.get(this.options.sessionId, manifest.objectId)
        if (isNull(body)) throw contextFailure('OBJECT_MISSING', '用户输入清单不可用。')
        const input = JSON.parse(body)
        if (input.files.some((item: { ref: ContextRef }) => sameContextRef(item.ref, ref))) {
          file = true
          break
        }
      }
      if (!file) throw contextFailure('INPUT_REF', '引用不是用户原始输入或其附件')
      return raw
    }
    if (raw.record.title !== 'user:manifest') return raw
    const manifest = JSON.parse(
      (await this.options.storage.get(this.options.sessionId, raw.record.objectId))!
    ) as { chars: number; chunks: ContextRef[] }
    const offset = boundedInteger(range.offset ?? 0, manifest.chars)
    const limit = boundedInteger(range.limit ?? ContextLimits.readChars, ContextLimits.readChars)
    let text = ''
    for (let cursor = offset; cursor < Math.min(manifest.chars, offset + limit);) {
      const chunk = manifest.chunks[Math.floor(cursor / ContextLimits.objectChars)]!
      const content = await this.read(chunk, {
        offset: cursor % ContextLimits.objectChars,
        limit: Math.min(
          limit - text.length,
          ContextLimits.objectChars - (cursor % ContextLimits.objectChars)
        ),
      })
      if (isEmpty(content.text)) throw contextFailure('OBJECT_MISSING', '输入归档分块不完整')
      text += content.text
      cursor += content.text.length
    }
    return { ...raw, text, offset, totalChars: manifest.chars }
  }

  public async summarizeInput(
    input: ContextInputSummary,
    signal?: AbortSignal
  ): Promise<ContextRef> {
    const state = await this.state()
    const record = this.record(state, input.ref)
    if (
      record.kind !== 'user' ||
      !input.summary.trim() ||
      JSON.stringify(input).length > 12000 ||
      !isArray(input.constraints) ||
      !isArray(input.unresolved)
    )
      throw contextFailure('INPUT_SUMMARY', '输入摘要合同无效')
    const current = state.inputSummaries?.find((item) => sameContextRef(item.input, input.ref))
    if ((current?.revision ?? 0) !== input.baseRevision)
      throw contextFailure('CONTEXT_CONFLICT', '输入摘要版本变化')
    const summary = await this.append(
      {
        kind: 'note',
        title: 'user:intent',
        body: JSON.stringify({
          summary: input.summary,
          constraints: input.constraints,
          unresolved: input.unresolved,
          origin: 'model-interpretation',
          original: input.ref,
        }),
        sources: [input.ref],
      },
      signal
    )
    for (;;) {
      const latest = await this.state()
      const prior = latest.inputSummaries?.find((item) => sameContextRef(item.input, input.ref))
      if ((prior?.revision ?? 0) !== input.baseRevision)
        throw contextFailure('CONTEXT_CONFLICT', '输入摘要版本变化')
      signal?.throwIfAborted()
      if (
        await this.options.storage.compareAndSwap(this.options.sessionId, latest.version, {
          ...latest,
          version: latest.version + 1,
          inputSummaries: [
            ...(latest.inputSummaries ?? []).filter(
              (item) => !sameContextRef(item.input, input.ref)
            ),
            { input: input.ref, summary: summary.ref, revision: input.baseRevision + 1 },
          ],
        })
      )
        return summary.ref
    }
  }

  public async projectInput(
    ref: ContextRef,
    maxChars: number,
    original = false
  ): Promise<ContextContent> {
    const raw = await this.readInput(ref, {
      limit: Math.max(1, Math.min(ContextLimits.readChars, maxChars)),
    })
    const storage = this.options.storage
    const state = storage.loadMetadata
      ? await storage.loadMetadata(this.options.sessionId)
      : storage.selectSnapshot
        ? (await storage.selectSnapshot(this.options.sessionId, []))?.metadata
        : await this.state()
    const entry = state?.inputSummaries?.find((item) => sameContextRef(item.input, ref))
    const manifest =
      raw.record.title === 'user:manifest'
        ? JSON.parse((await this.options.storage.get(this.options.sessionId, raw.record.objectId))!)
        : undefined
    const summary = entry
      ? await this.read(entry.summary, { limit: ContextLimits.readChars })
      : undefined
    if (original && summary && raw.totalChars > maxChars) {
      const excerptChars = Math.max(1, Math.min(128, Math.floor(maxChars / 4)))
      const tail = await this.readInput(ref, {
        offset: Math.max(excerptChars, raw.totalChars - excerptChars),
        limit: excerptChars,
      })
      return {
        ...raw,
        text: JSON.stringify({
          ref,
          position: 'user-input',
          totalChars: raw.totalChars,
          rangeUnit: 'utf16',
          representation: 'excerpt-with-summary',
          partial: true,
          bodyIncluded: true,
          files: manifest?.files ?? [],
          origin: 'user',
          excerpts: [
            { offset: 0, text: raw.text.slice(0, excerptChars) },
            { offset: tail.offset, text: tail.text },
          ],
          omittedChars: raw.totalChars - Math.min(excerptChars, raw.text.length) - tail.text.length,
          historicalInterpretation: {
            origin: 'model-interpretation',
            summaryRef: entry!.summary,
            revision: entry!.revision,
            intent: JSON.parse(summary.text),
          },
          read: { module: 'velaros:system', export: 'memory', operation: 'read', input: { ref } },
        }),
      }
    }
    const presentation = original ? undefined : summary
    if (!presentation && !manifest && raw.text.length === raw.totalChars) return raw
    const card = {
      ref,
      position: 'user-input',
      totalChars: raw.totalChars,
      rangeUnit: 'utf16',
      summaryRevision: entry?.revision ?? 0,
      files: manifest?.files ?? [],
      representation: presentation
        ? 'summary'
        : raw.text.length < raw.totalChars
          ? 'excerpt'
          : 'full',
      bodyIncluded: !presentation && !isEmpty(raw.text),
      sentRanges: presentation ? [] : [{ offset: raw.offset, limit: raw.text.length }],
      omittedChars: presentation ? raw.totalChars : raw.totalChars - raw.text.length,
      read: { module: 'velaros:system', export: 'memory', operation: 'read', input: { ref } },
      ...(presentation
        ? { summaryRef: entry!.summary, intent: JSON.parse(presentation.text) }
        : { text: raw.text }),
    }
    return { ...raw, text: JSON.stringify(card) }
  }

  public write(note: NoteWrite, signal?: AbortSignal): Promise<ContextRecord> {
    if (note.kind !== 'note' && note.kind !== 'checkpoint')
      throw contextFailure('INVALID_NOTE_KIND', '模型材料只能是笔记或工作检查点。')
    return this.append(note, signal)
  }
  public async read(ref: ContextRef, range: ContextReadRange = {}): Promise<ContextContent> {
    const record = await this.reference(ref)
    const text = await this.options.storage.get(this.options.sessionId, record.objectId)
    if (isNull(text)) throw contextFailure('OBJECT_MISSING', '记录的原始正文不可用。')
    const offset = boundedInteger(range.offset ?? 0, text.length)
    const limit = boundedInteger(range.limit ?? ContextLimits.readChars, ContextLimits.readChars)
    return { record, text: text.slice(offset, offset + limit), offset, totalChars: text.length }
  }
  public async search(query: ContextQuery): Promise<ContextSearchPage> {
    const state = await this.state()
    const offset = boundedInteger(query.offset ?? 0, Number.MAX_SAFE_INTEGER)
    const limit = boundedInteger(
      query.limit ?? ContextLimits.searchItems,
      ContextLimits.searchItems
    )
    if (!limit) throw contextFailure('INVALID_RANGE', '检索页大小必须大于零。')
    const needle = query.query.toLocaleLowerCase()
    const hits = []
    for (const record of state.records) {
      const body = await this.options.storage.get(this.options.sessionId, record.objectId)
      if (isNull(body)) throw contextFailure('OBJECT_MISSING', '检索材料的原文不可用。')
      const match = body.toLocaleLowerCase().indexOf(needle)
      if (match < 0 && !record.title.toLocaleLowerCase().includes(needle)) continue
      hits.push({
        ref: record.ref,
        kind: record.kind,
        title: record.title,
        preview: body.slice(Math.max(0, match), Math.max(0, match) + ContextLimits.previewChars),
      })
      if (hits.length > offset + limit) break
    }
    return {
      items: hits.slice(offset, offset + limit),
      nextOffset: hits.length > offset + limit ? offset + limit : null,
    }
  }
  public async replace(change: WorkingSetChange, signal?: AbortSignal): Promise<WorkingSetCommit> {
    boundedInteger(change.baseRevision, Number.MAX_SAFE_INTEGER)
    boundedInteger(change.items.length, ContextLimits.workingSetItems)
    const state = await this.state()
    if (state.workingSet.revision !== change.baseRevision)
      throw contextFailure('CONTEXT_CONFLICT', '工作集版本已变化，请重新 inspect 后提交。')
    boundedInteger(change.baseCursor, state.records.length)
    if (change.baseCursor < state.workingSet.cursor)
      throw contextFailure('CURSOR_CONFLICT', '不能使用早于已提交工作集的事件游标。')
    for (const ref of change.items) this.record(state, ref)
    const items = change.items.filter(
      (ref, index) => change.items.findIndex((other) => sameContextRef(ref, other)) === index
    )
    const workingSet = { revision: change.baseRevision + 1, cursor: change.baseCursor, items }
    signal?.throwIfAborted()
    if (
      !(await this.options.storage.compareAndSwap(this.options.sessionId, state.version, {
        ...state,
        version: state.version + 1,
        workingSet,
      }))
    )
      throw contextFailure('CONTEXT_CONFLICT', '提交期间有新记录到达，请 inspect 后重新提交。')
    return {
      revision: workingSet.revision,
      cursor: workingSet.cursor,
      effective: 'next-model-request',
    }
  }
  public async project(maxChars: number): Promise<ContextProjection> {
    boundedInteger(maxChars, Number.MAX_SAFE_INTEGER)
    const state = await this.state()
    const latestUser = [...state.records].reverse().find((record) => record.kind === 'user')
    const selected = state.records.filter(
      (record) =>
        state.workingSet.items.some((ref) => sameContextRef(ref, record.ref)) ||
        record === latestUser ||
        (record.sequence > state.workingSet.cursor &&
          record.kind !== 'note' &&
          record.kind !== 'checkpoint' &&
          record.kind !== 'audit')
    )
    const projectedSize = (record: ContextRecord): number =>
      record === latestUser &&
      record.sequence <= state.workingSet.cursor &&
      !state.workingSet.items.some((ref) => sameContextRef(ref, record.ref))
        ? Math.min(record.chars, ContextLimits.inputAnchorChars)
        : record.chars
    const chars = selected.reduce((sum, record) => sum + projectedSize(record), 0)
    if (chars > maxChars)
      throw contextFailure('CONTEXT_BUDGET', '活动材料超过预算，需要先整理工作集。')
    const records: ContextContent[] = []
    for (const record of selected) {
      const text = await this.options.storage.get(this.options.sessionId, record.objectId)
      if (isNull(text)) throw contextFailure('OBJECT_MISSING', '工作集引用的原文不可用。')
      records.push({
        record,
        text: text.slice(0, projectedSize(record)),
        offset: 0,
        totalChars: record.chars,
      })
    }
    return { revision: state.workingSet.revision, cursor: state.records.length, records, chars }
  }

  public async recover(maxChars: number): Promise<ContextProjection> {
    boundedInteger(maxChars, ContextLimits.readChars)
    const state = await this.state()
    const reverse = [...state.records].reverse()
    const selected = [
      reverse.find((record) => record.kind === 'user'),
      reverse.find((record) => record.kind === 'checkpoint'),
    ].filter((record): record is ContextRecord => Boolean(record))
    const records: ContextContent[] = []
    let remaining = maxChars
    for (const record of selected) {
      const body = await this.options.storage.get(this.options.sessionId, record.objectId)
      if (isNull(body)) throw contextFailure('OBJECT_MISSING', '恢复材料的原文不可用。')
      const text = body.slice(0, remaining)
      remaining -= text.length
      records.push({ record, text, offset: 0, totalChars: body.length })
    }
    return {
      revision: state.workingSet.revision,
      cursor: state.records.length,
      records,
      chars: maxChars - remaining,
    }
  }
}
/** 创建绑定会话的上下文运行时。 */
export function createContextRuntime(options: ContextRuntimeOptions): ContextRuntime {
  return new SessionContext(options)
}
