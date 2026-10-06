import type { ContextContent, ContextRef } from '@velaros-ai/context'
import { isArray, isEmpty, isPlainObject, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelResponseFormat } from '@velaros-ai/kernel'

import { ActiveContextLimits, ContextPatchLimits } from '../../system/contract/constants.js'
import type {
  ActiveContextPatch,
  ContextMaintenanceSnapshot,
  ContextPatch,
} from '../../system/types/maintenance.js'

/** 摘要与事项核对均投影生成合同；版本、状态和引文偏移由宿主绑定。 */
export function volumeNarrationFormat(
  schema: Readonly<Record<string, unknown>>
): ModelResponseFormat {
  const definitions = schema.definitions as Readonly<Record<string, Record<string, unknown>>>
  const root = definitions[(schema.$ref as string).split('/').at(-1)!]!
  const volume = expandSchema((root.properties as Record<string, unknown>).volume, definitions) as {
    properties: Record<string, unknown>
    required: string[]
  }
  const fields = ['summary', 'unresolved', 'negativeAttempts']
  const active = schemaFields(
    expandSchema((root.properties as Record<string, unknown>).active, definitions),
    ['changes']
  )
  const changes = active.properties.changes as Record<string, unknown>
  const change = schemaFields(changes.items, ['id', 'evidence'])
  const evidence = change.properties.evidence as Record<string, unknown>
  change.properties.evidence = {
    ...evidence,
    items: schemaFields(evidence.items, ['ref', 'quote']),
  }
  active.properties.changes = { ...changes, items: change }
  return {
    type: 'json',
    name: 'volume_narrative',
    description: '已封历史的事实摘要、新未解事项、失败尝试与有证据的事项解决',
    schema: {
      ...volume,
      properties: {
        ...Object.fromEntries(fields.map((key) => [key, volume.properties[key]])),
        active,
      },
      required: volume.required.filter((key) => fields.includes(key)),
    },
  }
}

/** 只选择生成对象中模型需填写的字段，其余必填元数据由宿主从已读快照补齐。 */
function schemaFields(value: unknown, fields: readonly string[]) {
  if (!isPlainObject(value) || !isPlainObject(value.properties) || !isArray(value.required))
    throw new AppError('INVARIANT', '自动叙事所需生成合同无效')
  const properties = value.properties
  return {
    ...value,
    properties: Object.fromEntries(fields.map((key) => [key, properties[key]])),
    required: value.required.filter((key) => isString(key) && fields.includes(key)),
  }
}

/** 仅展开生成合同可达的本地引用，不向供应商发送无关分区的 schema。 */
function expandSchema(value: unknown, definitions: Readonly<Record<string, unknown>>): unknown {
  if (isArray(value)) return value.map((item) => expandSchema(item, definitions))
  if (!isPlainObject(value)) return value
  if (isString(value.$ref))
    return expandSchema(definitions[value.$ref.split('/').at(-1)!], definitions)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandSchema(item, definitions)])
  )
}

/** 卷内新发现与持久当前事项分开；事项只按完整可见的真实执行证据逐项解决。 */
export function volumeNarrationPatch(
  snapshot: ContextMaintenanceSnapshot,
  value: unknown,
  evidence: readonly ContextRef[],
  records: readonly ContextContent[] = []
): ContextPatch {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some(
      (key) => !['summary', 'unresolved', 'negativeAttempts', 'active'].includes(key)
    ) ||
    !isString(value.summary) ||
    !value.summary.trim() ||
    value.summary.length > ContextPatchLimits.summaryChars ||
    !isArray(value.unresolved) ||
    !isArray(value.negativeAttempts) ||
    [value.unresolved, value.negativeAttempts].some(
      (items) =>
        items.length > ContextPatchLimits.unresolved ||
        items.some((item) => !isString(item) || item.length > ContextPatchLimits.unresolvedChars)
    )
  )
    throw new AppError('VALIDATION', '自动卷叙事格式或大小无效')
  const active = narrationActive(snapshot, value.active, records)
  const unresolved = [...new Set(value.unresolved as string[])]
  if (active) {
    const closed = new Set(active.changes.map((item) => item.id))
    const remaining = new Set(
      snapshot
        .active!.items.filter((item) => item.kind === 'question' && !closed.has(item.id))
        .map((item) => item.text)
    )
    if (
      snapshot.active!.items.some(
        (item) => closed.has(item.id) && !remaining.has(item.text) && unresolved.includes(item.text)
      )
    )
      throw new AppError('VALIDATION', '同一事项不能同时解决并作为新的未解事项发布')
  }
  const patch: ContextPatch = {
    baseRevision: snapshot.baseRevision,
    summary: value.summary,
    unresolved,
    volume: {
      summary: value.summary,
      unresolved,
      negativeAttempts: value.negativeAttempts as string[],
      evidence,
    },
  }
  return active ? { ...patch, active } : patch
}

/** 只有本卷完整可见的同会话执行结果可作为自动关闭事项的见证。 */
export function narrationWitness(
  snapshot: ContextMaintenanceSnapshot,
  page: ContextContent
): boolean {
  return (
    !!snapshot.volume &&
    page.offset === 0 &&
    page.text.length === page.totalChars &&
    page.record.ref.sessionId === snapshot.goals.at(-1)?.sessionId &&
    ['audit', 'tool'].includes(page.record.kind) &&
    /^script:(?:[a-f0-9]{8}|[0-9a-f-]{36}):result$/u.test(page.record.title) &&
    page.record.sequence > snapshot.volume.from &&
    page.record.sequence <= snapshot.volume.through
  )
}

/** 原文和一层 JSON 字符串值共用唯一匹配；见证最终保存不可变原文的 UTF-16 区间。 */
function narrationQuote(text: string, quote: string) {
  const spans = new Map<number, number>()
  for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) {
    spans.set(start, start + quote.length)
    if (spans.size > 1) break
  }
  let json = false
  try {
    JSON.parse(text)
    json = true
  } catch {
    // arch-guard:silent-catch-ok 普通执行文本只能按原文引用，不猜测其中的转义含义。
  }
  if (json && spans.size < 2) {
    for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/gu)) {
      const start = token.index
      const source = token[0]
      if (/^\s*:/u.test(text.slice(start + source.length))) continue
      const decoded = JSON.parse(source) as string
      if (!decoded.includes(quote)) continue
      const offsets = [start + 1]
      for (let index = 1; index < source.length - 1;) {
        index += source[index] === '\\' ? (source[index + 1] === 'u' ? 6 : 2) : 1
        offsets.push(start + index)
      }
      for (
        let index = decoded.indexOf(quote);
        index >= 0;
        index = decoded.indexOf(quote, index + 1)
      ) {
        const from = offsets[index]!
        const through = offsets[index + quote.length]!
        if (spans.has(from) && spans.get(from) !== through)
          throw new AppError('CONFLICT', '自动叙事引文在原文与 JSON 值中存在歧义')
        spans.set(from, through)
        if (spans.size > 1) break
      }
      if (spans.size > 1) break
    }
  }
  if (spans.size !== 1)
    throw new AppError(
      'CONFLICT',
      '自动叙事引文须唯一匹配执行原文或 JSON 字符串值；请包含足够上下文'
    )
  const [offset, end] = spans.entries().next().value!
  const original = text.slice(offset, end)
  if (original.length > ActiveContextLimits.quoteChars)
    throw new AppError('VALIDATION', '自动叙事引文对应的执行原文超过长度上限')
  return { offset, quote: original }
}

/** 模型只选已有未解项及执行见证；宿主校验来源和唯一引文后绑定原子补丁。 */
function narrationActive(
  snapshot: ContextMaintenanceSnapshot,
  value: unknown,
  records: readonly ContextContent[]
): Optional<ActiveContextPatch> {
  if (isUndefined(value)) return
  if (
    !snapshot.active ||
    !snapshot.volume ||
    !isPlainObject(value) ||
    Object.keys(value).some((key) => key !== 'changes') ||
    !isArray(value.changes) ||
    value.changes.length > ActiveContextLimits.changes
  )
    throw new AppError('VALIDATION', '自动叙事的当前事项核对无效')
  const latest = snapshot.goals.at(-1)
  const complete = (page: ContextContent) =>
    page.offset === 0 && page.text.length === page.totalChars
  if (
    !latest ||
    !records.some(
      (page) =>
        page.record.kind === 'user' &&
        page.record.ref.sessionId === latest.sessionId &&
        page.record.ref.id === latest.id &&
        complete(page)
    )
  )
    throw new AppError('CONTEXT_INPUT_UNSEEN', '自动核对事项前必须完整交付最新用户原文')
  const ids = new Set<string>()
  const changes: Array<ActiveContextPatch['changes'][number]> = []
  for (const item of value.changes) {
    if (
      !isPlainObject(item) ||
      Object.keys(item).some((key) => !['id', 'evidence'].includes(key)) ||
      !isString(item.id) ||
      ids.has(item.id) ||
      !snapshot.active.items.some((prior) => prior.id === item.id && prior.kind === 'question') ||
      !isArray(item.evidence) ||
      isEmpty(item.evidence) ||
      item.evidence.length > ActiveContextLimits.evidence
    )
      throw new AppError('VALIDATION', '自动叙事只能逐项解决现有未解事项')
    ids.add(item.id)
    const witnesses: Array<ActiveContextPatch['changes'][number]['evidence'][number]> = []
    for (const proof of item.evidence) {
      if (
        !isPlainObject(proof) ||
        Object.keys(proof).some((key) => !['ref', 'quote'].includes(key)) ||
        !isPlainObject(proof.ref) ||
        Object.keys(proof.ref).some((key) => !['sessionId', 'id'].includes(key)) ||
        !isString(proof.ref.sessionId) ||
        !isString(proof.ref.id) ||
        !isString(proof.quote) ||
        !proof.quote.trim() ||
        proof.quote.length > ActiveContextLimits.quoteChars
      )
        throw new AppError('VALIDATION', '自动叙事的执行见证无效')
      const ref = proof.ref
      const page = records.find(
        (page) => page.record.ref.sessionId === ref.sessionId && page.record.ref.id === ref.id
      )
      if (!page || !narrationWitness(snapshot, page))
        throw new AppError('PERMISSION', '自动叙事的见证必须来自本卷完整已读的真实执行结果')
      witnesses.push({ ref: page.record.ref, ...narrationQuote(page.text, proof.quote) })
    }
    changes.push({ id: item.id, status: 'resolved', evidence: witnesses })
  }
  return { baseRevision: snapshot.active.revision, reviewedInput: latest, changes }
}
