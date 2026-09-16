import { isArray, isBoolean, isFiniteNumber, isNumber, isObject, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { mapDefined } from '@velaros-ai/core/utils/mapDefined'
import { clamp } from '@velaros-ai/core/utils/number'

import type { ContextUsageEstimate } from '../../types/agent.js'
import type { ContextUsageWindow, EstimateContextUsageOptions } from '../../types/context.js'

import { resolveUsableContextWindow } from './context-budget'
import { countTokensTiktoken, resolveTokenizerEngine } from './tokenizer'

/** 界面提醒线，只表达接近容量，不触发压缩。 */
export const ContextUsageHighWatermarkPercent = 90
/** @deprecated 兼容旧消费者；自动治理只在完整请求超过可用输入容量时触发。 */
export const ContextUsageSemanticPreSummaryPercent = 100
/** 可用输入容量百分比；恰好装满仍可发送，超出才治理。 */
export const ContextUsageCompactionPercent = 100
/** 历史载荷诊断刻度，不能作为发送或压缩门限。 */
export const ContextUsagePayloadCompactionChars = 400_000

// 保持旧诊断图的字符刻度稳定；模型容量判决只使用 token 和 usableContextWindow。
const ContextUsagePayloadWindowChars = 500_000

const ObjectBoundaryTokenCost = 2
const ArrayBoundaryTokenCost = 2
const PropertyOverheadTokenCost = 1
const MessageBaseTokenCost = 4
const TextPartBaseTokenCost = 3
const FilePartBaseTokenCost = 18
const ToolPartBaseTokenCost = 8
const UnknownCycleTokenCost = 8
const NewlineTokenCost = 0.25
const TabTokenCost = 0.25
const AsciiPunctuationTokenCost = 0.5
const NonAsciiPunctuationTokenCost = 0.75
const EmojiTokenCost = 2
const CjkTokenCost = 1
const OtherUnicodeTokenCost = 1

/**
 * 把一段 base64 正文换成 `[base64 N bytes]` 的一行摘要，N 由串长按 3/4 反推（不解码，末尾的 `=` 填充算进去，故略有高估）。
 * 计量只需要体积不需要内容：一张截图的 base64 按字符计税会被记成几万 token，直接压穿治理水位。
 */
function summarizeBase64(data: string): string {
  return `[base64 ${Math.ceil((data.length * 3) / 4)} bytes]`
}

/**
 * 把一个二进制载荷换成计量用的短摘要：字符串按 base64 摘要，ArrayBuffer 与其视图记 `[binary N bytes]`，
 * URL 转成串（URL 本身就是短引用，不必摘），其余类型原样返回。
 * 只影响计量视图，原始载荷不动。
 */
function summarizeBinaryValue(value: unknown): unknown {
  if (isString(value)) return summarizeBase64(value)

  if (value instanceof URL) return value.toString()

  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`

  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`

  return value
}

/**
 * 递归产出用于计量的上下文副本：把各类附件正文换成体积摘要，其余结构原样递归。
 * 认四类片段——`image` 的 `image`、`file` 的 `data`，以及工具结果里的 `image-data`/`media`/`file-data` 的 `data`；
 * 另外单独处理 `imageAttachments` 数组，逐个把 `data` 摘要掉。
 * 这只是计量视图：原始载荷一个字节没变，模型看到的仍是完整内容。不摘的后果见函数体内注释（166KB 图曾被记成 ~5.5 万 token 触发连环压缩）。
 */
function sanitizeContextValue(value: unknown): unknown {
  if (isArray(value)) return value.map((entry) => sanitizeContextValue(entry))

  if (!value || !isPlainObject(value)) return value

  const record = value
  if (record.type === 'image' && isPresent(record.image)) return {
      ...record,
      image: summarizeBinaryValue(record.image),
    }

  if (record.type === 'file' && isPresent(record.data)) return {
      ...record,
      data: summarizeBinaryValue(record.data),
    }

  // 工具结果里的二进制内容块（截图走 image-data）：不摘要的话一张截图的 base64
  // 会被当普通文本计税（曾把 166KB 模型图记成 ~5.5 万 token，直接压穿治理水位
  // 触发连环压缩）。供应方对图片按视觉口径计费，远低于字符口径。
  if (
    (record.type === 'image-data' || record.type === 'media' || record.type === 'file-data')
    && isPresent(record.data)
  ) return {
      ...record,
      data: summarizeBinaryValue(record.data),
    }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (key === 'imageAttachments' && isArray(entry)) return [
          key,
          entry.map((attachment) => {
            if (!attachment || !isPlainObject(attachment)) return attachment

            const attachmentRecord = attachment
            return {
              ...attachmentRecord,
              data: summarizeBinaryValue(attachmentRecord.data),
            }
          }),
        ]

      return [key, sanitizeContextValue(entry)]
    })
  )
}

/** 发送计量与驻留治理共用附件归一化后的字符口径，原始载荷保持完整。 */
export function estimateContextValueChars(value: unknown): number {
  const normalized = sanitizeContextValue(value)
  return isString(normalized) ? normalized.length : (JSON.stringify(normalized)?.length ?? 0)
}

/** 统计参与本轮的媒体片段，供界面标记附件用量尚不可精确计量。 */
export function countContextMediaParts(value: unknown, seen = new Set<object>()): number {
  if (!isObject(value) || seen.has(value)) return 0
  seen.add(value)
  if (isArray(value)) return value.reduce<number>((sum, item) => sum + countContextMediaParts(item, seen), 0)
  if (!isPlainObject(value)) return 0
  if (
    (value.type === 'image' && isPresent(value.image))
    || (['file', 'image-data', 'file-data', 'media'].includes(String(value.type)) && isPresent(value.data))
  ) return 1
  return Object.entries(value).reduce(
    (sum, [key, item]) => sum + (key === 'imageAttachments' && isArray(item)
      ? item.length
      : countContextMediaParts(item, seen)),
    0,
  )
}

/**
 * 该码位是否是四种 ASCII 空白之一：空格、制表符、换行、回车。
 * 只认这四种（不含换页、垂直制表符等）——估算把它们当 ASCII 连续段的切分点，多认反而会把词切碎、抬高估值。
 */
function isAsciiWhitespace(charCode: number): boolean {
  return charCode === 0x20 || charCode === 0x09 || charCode === 0x0a || charCode === 0x0d
}

/**
 * 该码位是否是 ASCII 字母或数字（0-9、A-Z、a-z）；下划线、连字符都不算。
 * 是 token 估算里「词」的构成字符，与标点判定互补。
 */
function isAsciiAlphaNumeric(charCode: number): boolean {
  return (
    (charCode >= 0x30 && charCode <= 0x39)
    || (charCode >= 0x41 && charCode <= 0x5a)
    || (charCode >= 0x61 && charCode <= 0x7a)
  )
}

/**
 * 该码位是否算 ASCII 标点——定义为「在 ASCII 范围内、既不是空白也不是字母数字」，所以控制字符也归进这一类。
 * 按补集定义而非枚举标点表：估算只需把这些字符按固定单价计税，归错类别不影响量级。
 */
function isAsciiPunctuation(charCode: number): boolean {
  return charCode <= 0x7f && !isAsciiWhitespace(charCode) && !isAsciiAlphaNumeric(charCode)
}

/**
 * 该码位是否落在 CJK 及日韩假名区段：汉字扩展 A、基本汉字、兼容汉字、平假名、片假名、谚文音节。
 * 命中的字符按「一字约一 token」计——与 ASCII 的「约四字符一 token」差四倍，中文长会话不单独算就会被严重低估。
 * 只覆盖常用区段，不含扩展 B 及以上的罕用汉字（那些会落到 OtherUnicode 那一档，单价相同）。
 */
function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x3040 && codePoint <= 0x309f)
    || (codePoint >= 0x30a0 && codePoint <= 0x30ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
  )
}

/**
 * 该码位是否落在两段主要 emoji 区（U+1F300–U+1FAFF 与杂项符号 U+2600–U+27BF）。
 * 命中按 EmojiTokenCost 计——emoji 多是多字节序列，一个符号往往吃掉不止一个 token。粗略覆盖即可，漏掉的变体选择符等会落到通用档。
 */
function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x2600 && codePoint <= 0x27bf)
  )
}

/**
 * 该字符是否属于 Unicode 标点或符号类（`\p{P}` 或 `\p{S}`）——中文全角标点、数学符号、货币符号等都算。
 * 非 ASCII 段里靠它区分「标点按 NonAsciiPunctuationTokenCost 计」还是「按 OtherUnicodeTokenCost 计」。
 */
function isUnicodePunctuation(char: string): boolean {
  return /[\p{P}\p{S}]/u.test(char)
}

/**
 * 估一段连续 ASCII 文本（不含空白）的 token 数：按非字母数字字符切成词，每个词按 4 字符一 token 向上取整，
 * 再加上段内每个 ASCII 标点的固定单价。空串返回 0。
 * 标点单独计是关键——`a.b.c` 这类密集标点的代码/路径串若只按词长折算会明显低估。
 */
function estimateAsciiRunTokens(run: string): number {
  if (!run) return 0

  const segments = run.split(/[^A-Za-z0-9]+/u).filter(Boolean)
  let punctuationCount = 0

  for (let index = 0; index < run.length; index += 1) {
    if (isAsciiPunctuation(run.charCodeAt(index))) {
      punctuationCount += 1
    }
  }

  const alphaNumericTokens = segments.reduce(
    (total, segment) => total + Math.ceil(segment.length / 4),
    0,
  )

  return alphaNumericTokens + (punctuationCount * AsciiPunctuationTokenCost)
}

/**
 * 这段文本看着像不像 JSON 之类的结构化载荷：trim 后被 `{}` 或 `[]` 整体包住，
 * 或出现 `"key": [ { "` 这类形态，或同时含括号与冒号。空白串为假。
 * 为真时估算会另取一条更保守的下界（约 3.5 字符 / token）——结构化文本的 token 密度比自然语言高，按自然语言口径会低估。
 * 只是启发式，允许误判：两条估计取大，判错方向只会更保守。
 */
function looksLikeStructuredText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  return (
    ((trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']')))
    || /":\s*(?:\[|\{|")/u.test(trimmed)
    || /[{[\]}]/u.test(trimmed) && /:\s*/u.test(trimmed)
  )
}

/**
 * 估一段文本的 token 数（没有真分词器时的兜底口径）：逐码位扫描，ASCII 攒成连续段交给 estimateAsciiRunTokens，
 * 空白处结算并按换行/制表符各记一份小额开销，非 ASCII 分 CJK、emoji、Unicode 标点、其它四档各按单价累加。
 * 结构化文本再取一条 3.5 字符/token 的保守下界与之取大，最后向上取整。
 * 空串返回 0；非空文本至少记 1 token——不允许出现「零成本的正文」，否则它会绕过所有预算闸门。
 */
function estimateStringTokens(text: string): number {
  if (!text) return 0

  let estimated = 0
  let asciiRun = ''

  const flushAsciiRun = (): void => {
    if (!asciiRun) return

    estimated += estimateAsciiRunTokens(asciiRun)
    asciiRun = ''
  }

  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (!isNumber(codePoint)) {
      continue
    }

    if (codePoint <= 0x7f) {
      if (isAsciiWhitespace(codePoint)) {
        flushAsciiRun()
        if (char === '\n' || char === '\r') {
          estimated += NewlineTokenCost
        } else if (char === '\t') {
          estimated += TabTokenCost
        }
        continue
      }

      asciiRun += char
      continue
    }

    flushAsciiRun()

    if (isCjkCodePoint(codePoint)) {
      estimated += CjkTokenCost
      continue
    }

    if (isEmojiCodePoint(codePoint)) {
      estimated += EmojiTokenCost
      continue
    }

    estimated += isUnicodePunctuation(char)
      ? NonAsciiPunctuationTokenCost
      : OtherUnicodeTokenCost
  }

  flushAsciiRun()

  const conservativeStructuredEstimate = looksLikeStructuredText(text)
    ? Math.ceil(text.trim().length / 3.5)
    : 0

  return Math.max(1, Math.ceil(Math.max(estimated, conservativeStructuredEstimate)))
}

/**
 * 这个对象长不长得像一条模型消息——纯对象、`role` 是字符串、`content` 非空即可，不校验 role 取值也不管 content 形状。
 * 判定成立就按「消息」计价（多一份固定开销），否则按普通对象逐键累加；宽松是故意的，估算宁可把像消息的东西算贵一点。
 */
function isModelMessageLike(value: unknown): value is { role: string; content: unknown } {
  if (!isPlainObject(value) || !isPresent(value)) return false

  const record = value
  return isString(record.role) && isPresent(record.content)
}

/**
 * 估一个普通对象的 token 数：从对象边界开销起步，每个键累加「键名 token + 一份属性开销（冒号逗号引号）+ 值的 token」。
 * `seen` 沿递归传下去防循环引用。键名也计税——JSON 包装本身就要发给模型，不能只算值。
 */
function estimateEntriesTokens(
  entries: Array<[string, unknown]>,
  seen: Set<object>,
): number {
  return entries.reduce(
    (total, [key, entry]) =>
      total
      + estimateStringTokens(key)
      + PropertyOverheadTokenCost
      + estimateValueTokens(entry, seen),
    ObjectBoundaryTokenCost,
  )
}

/**
 * 估一条模型消息的 token 数：一份消息固定开销（provider 的角色分隔符等）+ role 串 + content 递归估值。
 * 走这支就不再按普通对象逐键算，免得把 role/content 两个键的包装开销重复计入。
 */
function estimateMessageTokens(
  value: { role: string; content: unknown },
  seen: Set<object>,
): number {
  return (
    MessageBaseTokenCost
    + estimateStringTokens(value.role)
    + estimateValueTokens(value.content, seen)
  )
}

/**
 * 按 `type` 给已知的内容片段分档计价：text 用文本档（正文 + 可能的 value），image/file 用文件档（正文此时已是体积摘要 + mediaType），
 * tool-call / tool-result 用工具档（工具名 + toolCallId + input/output 递归）。
 * 认不出的 type 落回按普通对象逐键累加，所以新增片段类型不会漏计，只是少了那份专属固定开销。
 */
function estimateTypedPartTokens(
  value: Record<string, unknown>,
  seen: Set<object>,
): number {
  const type = isString(value.type) ? value.type : ''
  switch (type) {
    case 'text':
      return (
        TextPartBaseTokenCost
        + estimateStringTokens(String(value.text ?? ''))
        + estimateValueTokens(value.value, seen)
      )
    case 'image':
      return (
        FilePartBaseTokenCost
        + estimateStringTokens(String(value.image ?? ''))
        + estimateStringTokens(String(value.mediaType ?? ''))
      )
    case 'file':
      return (
        FilePartBaseTokenCost
        + estimateStringTokens(String(value.data ?? ''))
        + estimateStringTokens(String(value.mediaType ?? ''))
      )
    case 'tool-call':
      return (
        ToolPartBaseTokenCost
        + estimateStringTokens(String(value.toolName ?? ''))
        + estimateStringTokens(String(value.toolCallId ?? ''))
        + estimateValueTokens(value.input, seen)
      )
    case 'tool-result':
      return (
        ToolPartBaseTokenCost
        + estimateStringTokens(String(value.toolName ?? ''))
        + estimateStringTokens(String(value.toolCallId ?? ''))
        + estimateValueTokens(value.output, seen)
      )
    default:
      return estimateEntriesTokens(Object.entries(value), seen)
  }
}

/**
 * 估任意值的 token 数，是无分词器兜底路径的递归总入口。
 * 分派：字符串与数字按文本估；布尔与 null/undefined 各记 1；URL 转串；ArrayBuffer 及其视图先换成体积摘要再估；
 * 数组从边界开销起逐项累加；非纯对象按 `String(value)` 估；纯对象里，像消息的走消息档，带 `type` 的走片段档，其余逐键累加。
 * 循环引用返回固定的 UnknownCycleTokenCost 而不是继续下探——估算绝不能因为一个环就转不出来。
 * 注意 `seen` 只加不删，同一个对象在同一次估算里被多处引用时，第二次起只按环开销计（偏低），换来的是估算恒定终止。
 */
function estimateValueTokens(value: unknown, seen: Set<object>): number {
  if (isString(value)) return estimateStringTokens(value)

  if (isNumber(value)) return estimateStringTokens(String(value))

  if (isBoolean(value)) return 1

  if (!isPresent(value)) return 1

  if (value instanceof URL) return estimateStringTokens(value.toString())

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return estimateStringTokens(String(summarizeBinaryValue(value)))

  if (isArray(value)) return value.reduce<number>(
      (total, entry) => total + estimateValueTokens(entry, seen),
      ArrayBoundaryTokenCost,
    )

  if (!isPlainObject(value)) return estimateStringTokens(String(value))

  if (seen.has(value)) return UnknownCycleTokenCost

  seen.add(value)

  if (isModelMessageLike(value)) return estimateMessageTokens(value, seen)

  const record = value
  if (isString(record.type)) return estimateTypedPartTokens(record, seen)

  return estimateEntriesTokens(Object.entries(record), seen)
}

/**
 * 送核门窗口口径的**唯一推导**（`estimateContextUsage` 与治理窗口共用）。
 *
 * 水位一律按模型真实窗口百分比计；请求体积由注意力路由、压缩与回收阶梯独立约束。
 * 预算调优为可选项：仅当调用方提供输出预留/安全余量时，才把百分比改对“可用窗口”计量；
 * 否则退化为旧行为（usable == contextWindow），保证既有调用与测试不变。
 *
 * 抽成独立函数不是为了复用美感，而是因为**治理窗口 G 必须与送核门同源**：这段条件退化
 * （`hasBudgetTuning`）一旦被抄一份，两把尺子就会在"调用方没传预算调优"这类边角上分叉，
 * 治理器算出来的占用比送核门小一大截，于是它总在撞门之后才醒（审计 #4）。
 */
export function resolveContextUsageWindow(
  options: Pick<
    EstimateContextUsageOptions,
    'contextWindow' | 'reservedOutputTokens' | 'safetyMarginPercent'
  >
): ContextUsageWindow {
  const contextWindow = isFiniteNumber(options.contextWindow)
    ? Math.max(1, Math.floor(options.contextWindow))
    : 128_000
  const hasBudgetTuning =
    isFiniteNumber(options.reservedOutputTokens) || isFiniteNumber(options.safetyMarginPercent)
  const reservedOutputTokens = hasBudgetTuning
    ? Math.max(0, Math.floor(options.reservedOutputTokens ?? 0))
    : 0
  const safetyMarginPercent = hasBudgetTuning ? clamp(options.safetyMarginPercent ?? 0, 0, 90) : 0
  const usableContextWindow = hasBudgetTuning
    ? resolveUsableContextWindow({ contextWindow, reservedOutputTokens, safetyMarginPercent })
    : contextWindow

  return { contextWindow, usableContextWindow, reservedOutputTokens, safetyMarginPercent }
}

/**
 * 估这一轮上下文的总用量：附件先摘要成体积记号，再把 systemPrompt / history / extraContext 打成一份载荷序列化。
 * token 优先用 tiktoken 直接对序列化后的 JSON 跑 BPE（连 role/content/tool-call 的 JSON 包装成本一起算进去，最贴近供应方计费口径，
 * 此时不再叠加 MessageBase/PartBase 那些启发式常量）；没有 tiktoken 则走 estimateValueTokens 的启发式递归；两条都抛错就退到「字符数 ÷ 4」的确定性兜底。
 * 随后乘上 MMU 学到的 `calibrationFactor`（给了正值才乘），最少记 1 token。
 * 百分比按可用窗口算（`tokenPercent`，也是对外的 `percent`）；`payloadPercent` 只是固定字符刻度上的诊断值，不能当发送或压缩门限。
 * 带媒体片段时 `mediaTokenCoverage` 记 `'unknown'`——图片的真实计费按视觉口径，这里不声称算得准。
 */
export function estimateContextUsage(
  model: string,
  systemPrompt: string,
  history: unknown,
  options: EstimateContextUsageOptions = {}
): ContextUsageEstimate {
  const mediaPartCount = countContextMediaParts(history) + countContextMediaParts(options.extraContext)
  const sanitizedHistory = sanitizeContextValue(history)
  const sanitizedExtraContext = mapDefined(options.extraContext, sanitizeContextValue)
  const contextPayload =
    !isPresent(sanitizedExtraContext)
      ? {
          systemPrompt,
          history: sanitizedHistory,
        }
      : {
          systemPrompt,
          history: sanitizedHistory,
          extraContext: sanitizedExtraContext,
        }
  const serializedPayload = JSON.stringify(contextPayload) ?? ''
  const extraEstimatedTokens = Math.max(0, Math.ceil(options.extraEstimatedTokens ?? 0))
  const extraEstimatedChars = Math.max(0, Math.ceil(options.extraEstimatedChars ?? 0))
  const estimatedChars = serializedPayload.length + extraEstimatedChars
  const engine = resolveTokenizerEngine()
  let estimatedTokens = 0

  try {
    if (engine === 'tiktoken') {
      // 直接在序列化后的 JSON 上跑 BPE：包含了 role/content/tool-call 等 JSON 包装的真实 token 成本，
      // 与上游 AI provider 计费口径最接近；不再额外加 MessageBase/PartBase 这类启发式常量。
      estimatedTokens = Math.max(1, countTokensTiktoken(serializedPayload) + extraEstimatedTokens)
    } else {
      estimatedTokens = Math.max(
        1,
        Math.ceil(
          estimateValueTokens(contextPayload, new Set<object>()) + extraEstimatedTokens
        ),
      )
    }
  } catch {
    // arch-guard:silent-catch-ok 估算 token 失败时退回按字符数的确定性估算。
    estimatedTokens = Math.ceil(estimatedChars / 4)
  }

  // MMU 校准：把“估算→真实”学到的残差系数乘进估算值，使其贴近供应方真实输入用量。
  const calibrationFactor = options.calibrationFactor
  if (isFiniteNumber(calibrationFactor) && calibrationFactor > 0) {
    estimatedTokens = Math.max(1, Math.ceil(estimatedTokens * calibrationFactor))
  }

  const window = resolveContextUsageWindow(options)
  const { contextWindow, usableContextWindow, reservedOutputTokens } = window
  const tokenPercent = Number(((estimatedTokens / usableContextWindow) * 100).toFixed(2))
  const payloadPercent = Number(
    ((estimatedChars / ContextUsagePayloadWindowChars) * 100).toFixed(2)
  )
  const percent = tokenPercent

  return {
    mediaTokenCoverage: mediaPartCount > 0 ? 'unknown' : 'none',
    mediaPartCount,
    estimatedTokens,
    estimatedChars,
    contextWindow,
    usableContextWindow,
    reservedOutputTokens,
    tokenPercent,
    payloadPercent,
    percent,
  }
}

/**
 * 把本轮允许的工具的 schema 字符数加起来，作为请求里工具定义那块的精确预留。
 * 只要有任何一个工具在这张实测表里查不到，就返回 null——半张表比没有更危险，调用方据此回落到平均估算。
 */
export function sumToolSchemaChars(
  allowedTools: readonly string[],
  toolSchemaChars?: Readonly<Record<string, number>>
): Nullable<number> {
  if (!toolSchemaChars) return null

  let total = 0
  for (const toolName of allowedTools) {
    if (!Object.prototype.hasOwnProperty.call(toolSchemaChars, toolName)) return null
    total += Math.max(0, toolSchemaChars[toolName] ?? 0)
  }

  return total
}
