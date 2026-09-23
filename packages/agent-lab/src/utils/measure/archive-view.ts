/**
 * 历史归档视图：v0/v1/v2/v3 四代归档都按原样读出来，缺的字段一律 `null`，一个字段都不补、不改。
 * 纯测量：不碰 Node 模块、不发请求。
 */
import type { ArchiveShape } from '../../contract/constants.js'
import type { JsonObject, JsonValue, RunArchive, RunArchiveView } from '../../types/agent-lab.js'
import { runArchiveSchema } from '../wire/journey.js'

/** 这个值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 把任意值折成 JSON 值；有 `NaN`、函数这类折不动的东西就整体判失败。 */
function toJsonValue(
  value: unknown
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false } {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return { ok: true, value }
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : { ok: false }
  if (Array.isArray(value)) {
    const values: JsonValue[] = []
    for (const item of value) {
      const parsed = toJsonValue(item)
      if (!parsed.ok) return { ok: false }
      values.push(parsed.value)
    }
    return { ok: true, value: values }
  }
  if (isRecord(value)) {
    const object: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const parsed = toJsonValue(item)
      if (!parsed.ok) return { ok: false }
      object[key] = parsed.value
    }
    return { ok: true, value: object }
  }
  return { ok: false }
}

/** 折成 JSON 值，折不动就是 `null`。 */
function jsonValue(value: unknown): JsonValue | null {
  const parsed = toJsonValue(value)
  return parsed.ok ? parsed.value : null
}

/** 是字符串就取它，否则是未知。 */
function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 是有限数就取它，否则是未知。 */
function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 折成一个 JSON 数组；不是数组就是空数组，折不动的项直接丢掉。 */
function jsonArray(value: unknown): readonly JsonValue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const parsed = jsonValue(item)
    return parsed === null ? [] : [parsed]
  })
}

/** 折成一个 JSON 对象；不是对象就是未知。 */
function jsonObject(value: unknown): JsonObject | null {
  const parsed = jsonValue(value)
  return isRecord(parsed) ? (parsed as JsonObject) : null
}

/** 造一份「什么都没读出来」的视图。 */
function empty(
  shape: ArchiveShape,
  raw: JsonValue | null,
  errors: readonly string[] = []
): RunArchiveView {
  return {
    shape,
    archive: null,
    manifest: null,
    runId: null,
    sessionId: null,
    rounds: [],
    passed: null,
    total: null,
    findings: null,
    drops: null,
    usage: null,
    context: null,
    raw,
    errors,
  }
}

/** 读任意一代归档：先按 v3 严格校验，过不了再按 v2/v1/v0 的形状读，缺的字段保持缺。 */
export function readRunArchiveView(input: unknown): RunArchiveView {
  if (input === null || input === undefined) return empty('missing', null)
  const raw = jsonValue(input)
  if (raw === null) return empty('invalid', null, ['归档不是合法的 JSON 数据'])

  const v3 = runArchiveSchema.safeParse(input)
  if (v3.success) {
    const archive: RunArchive = v3.data
    return {
      shape: 'v3',
      archive,
      manifest: jsonObject(archive.manifest),
      runId: archive.manifest.runId,
      sessionId: null,
      rounds: jsonArray(archive.legs),
      passed: archive.legs.every((leg) => leg.passed === null)
        ? null
        : archive.legs.filter((leg) => leg.passed === true).length,
      total: archive.legs.length,
      findings: jsonArray(archive.findings),
      drops: jsonArray(archive.drops),
      usage: jsonObject(archive.usage),
      context: jsonObject(archive.context),
      raw,
      errors: [],
    }
  }

  if (Array.isArray(input))
    return { ...empty('v0-array', raw), rounds: jsonArray(input), total: input.length }
  if (!isRecord(input)) return empty('invalid', raw, ['归档的根必须是对象或数组'])

  if (isRecord(input.manifest)) {
    const rounds = jsonArray(input.rounds)
    return {
      ...empty('v2-manifest', raw),
      manifest: jsonObject(input.manifest),
      runId: nullableString(input.manifest.runId),
      sessionId: nullableString(input.manifest.sessionId),
      rounds,
      passed: nullableNumber(input.manifest.passedRounds),
      total: nullableNumber(input.manifest.totalRounds) ?? rounds.length,
      findings: Array.isArray(input.findings) ? jsonArray(input.findings) : null,
      drops: Array.isArray(input.drops) ? jsonArray(input.drops) : null,
      usage: jsonObject(input.usage),
      context: jsonObject(input.governance ?? input.context),
    }
  }

  const rounds = jsonArray(input.rounds ?? input.records ?? input.results)
  return {
    ...empty('v1-flat', raw),
    sessionId: nullableString(input.sessionId),
    rounds,
    passed: nullableNumber(input.passed),
    total: nullableNumber(input.total) ?? (rounds.length > 0 ? rounds.length : null),
    findings: Array.isArray(input.findings) ? jsonArray(input.findings) : null,
    drops: null,
    usage: jsonObject(input.usage),
    context: jsonObject(input.governance ?? input.context),
  }
}
