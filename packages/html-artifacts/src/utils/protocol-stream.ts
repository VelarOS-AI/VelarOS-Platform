/**
 * 增量协议的状态机本体：一段一段喂文本进来，吐出可以直接渲染的事件。
 * 全是纯函数——改动的是调用方传进来的那个状态对象，本文件自己不存任何状态。
 * chunk 可以断在半个标签、半条 CSS 规则、半段 Base64 里：只有凑齐完整、安全的边界才会发事件。
 */
import type { HtmlArtifactProtocolDiagnosticCode } from '../contract/constants.js'
import {
  HtmlArtifactDefaults,
  HtmlArtifactProtocolContract,
  HtmlArtifactProtocolLimitDefaults,
} from '../contract/constants.js'
import type {
  HtmlArtifactActionState,
  HtmlArtifactActionType,
  HtmlArtifactDescriptor,
  HtmlArtifactProtocolEvent,
  HtmlArtifactProtocolLimits,
  HtmlArtifactProtocolStreamOptions,
  HtmlArtifactProtocolStreamState,
  HtmlArtifactSnapshot,
} from '../types/html-artifacts.js'
import type { ParsedProtocolTag } from '../types/internals.js'

import { isFiniteNumber, isNotNull, isString, isUndefined, toNullable } from './runtime-guards.js'
import { HtmlArtifactTuning } from './tuning.js'

const ARTIFACT_OPEN = `<${HtmlArtifactProtocolContract.artifactTag}`
const ARTIFACT_CLOSE = `</${HtmlArtifactProtocolContract.artifactTag}>`
const PATCH_OPEN = `<${HtmlArtifactProtocolContract.patchTag}`
const PATCH_CLOSE = `</${HtmlArtifactProtocolContract.patchTag}>`
const PARTIAL_PROTOCOL_CANDIDATES = [ARTIFACT_OPEN, PATCH_OPEN, ARTIFACT_CLOSE, PATCH_CLOSE]
const MARKDOWN_PARTIAL_PROTOCOL_CANDIDATES = [ARTIFACT_OPEN]
// 这些标签没有闭合标签：流式发到它们结束就已经是安全的 HTML 边界。
const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** 按缺省值补齐一个资源上限：给的不是正数就用缺省。 */
function normalizeLimit(value: LooseOptional<number>, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? Math.round(value) : fallback
}

/** 把宿主给的资源上限补成完整的一套。 */
function resolveProtocolLimits(
  limits: HtmlArtifactProtocolLimits = {}
): Required<HtmlArtifactProtocolLimits> {
  return {
    maxActionPayloadLength: normalizeLimit(
      limits.maxActionPayloadLength,
      HtmlArtifactProtocolLimitDefaults.maxActionPayloadLength
    ),
    maxArtifactHtmlLength: normalizeLimit(
      limits.maxArtifactHtmlLength,
      HtmlArtifactProtocolLimitDefaults.maxArtifactHtmlLength
    ),
    maxArtifactProtocolTextLength: normalizeLimit(
      limits.maxArtifactProtocolTextLength,
      HtmlArtifactProtocolLimitDefaults.maxArtifactProtocolTextLength
    ),
    maxBufferLength: normalizeLimit(
      limits.maxBufferLength,
      HtmlArtifactProtocolLimitDefaults.maxBufferLength
    ),
  }
}

/** 截掉超出上限的尾部。 */
function clipText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength)
}

/** 只留最后这么长的一段，前面的丢掉；缓冲区用它防住无限攒。 */
function clipTail(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(value.length - maxLength)
}

/** 归一化制品标题：空白折成一个空格、按上限截断，空了就用缺省标题。 */
function clampArtifactTitle(title: string): string {
  const normalizedTitle = title.replace(/\s+/g, ' ').trim()
  return (
    normalizedTitle.slice(0, HtmlArtifactProtocolLimitDefaults.maxArtifactTitleLength)
    || HtmlArtifactDefaults.title
  )
}

/** 归一化显式写出来的制品 id：只留下 `\w.-`，两头的连字符去掉，按上限截断；空了返回 null。 */
function normalizeExplicitArtifactId(id: string): Nullable<string> {
  const normalizedId = id
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, HtmlArtifactProtocolLimitDefaults.maxArtifactIdLength)

  return normalizedId || null
}

/** 读 `<artifact height="…">`：不是正数就当没写，是正数就钳进声明高度的上下界。 */
function parsePositiveHeight(value: Nullable<string>): Optional<number> {
  if (!value) return undefined

  const numericValue = +value
  if (!Number.isFinite(numericValue) || numericValue <= 0) return undefined

  return Math.max(
    HtmlArtifactDefaults.declaredHeightMin,
    Math.min(Math.round(numericValue), HtmlArtifactDefaults.declaredHeightMax)
  )
}

/** 读 `<artifact version="…">`：没写按当前版本算，写了但对不上就返回 null，整段原样当 Markdown。 */
function readArtifactProtocolVersion(value: LooseOptional<string>): Nullable<string> {
  if (!value) return HtmlArtifactProtocolContract.version

  const normalized = value.trim()
  return normalized === HtmlArtifactProtocolContract.version ? normalized : null
}

/** 把一段标签原文解析成标签名与属性表；标签名对不上期望值就返回 null。 */
function parseTag(tagText: string, expectedName: string): Nullable<ParsedProtocolTag> {
  const openMatch = tagText.match(/^<([A-Za-z][\w:-]*)([\s\S]*)>$/)
  if (!openMatch || openMatch[1] !== expectedName) return null

  const attributes: Record<string, string> = {}
  const attributeText = openMatch[2] ?? ''
  const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: Nullable<RegExpExecArray>

  while ((match = attributePattern.exec(attributeText))) {
    const key = match[1]
    const value = match[2] ?? match[3] ?? ''
    attributes[key] = value
  }

  return { raw: tagText, attributes }
}

/** 找出缓冲区尾部那段「可能是半个协议标签」的起点；没有就返回 -1。 */
function findPartialProtocolStart(
  text: string,
  candidates: readonly string[] = PARTIAL_PROTOCOL_CANDIDATES
): number {
  const maxCandidateLength = Math.max(...candidates.map((candidate) => candidate.length))
  const startIndex = Math.max(0, text.length - maxCandidateLength + 1)

  for (let index = startIndex; index < text.length; index += 1) {
    const suffix = text.slice(index)
    if (suffix && candidates.some((candidate) => candidate.startsWith(suffix))) return index
  }

  return -1
}

/** 从 `<` 往后找这个标签的 `>`，引号里的 `>` 不算；找不到返回 -1。 */
function findTagEnd(text: string, openIndex: number): number {
  let quote: Nullable<string> = null

  for (let index = openIndex + 1; index < text.length; index += 1) {
    const char = text[index]

    if (quote) {
      if (char === quote) quote = null
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '>') return index
  }

  return -1
}

/** 找一段 HTML 里某个标签的结束位置，规则同 `findTagEnd`。 */
function findHtmlTagEnd(text: string, openIndex: number): number {
  return findTagEnd(text, openIndex)
}

/** 有内容才发一条 Markdown 事件。 */
function emitMarkdown(events: HtmlArtifactProtocolEvent[], text: string): void {
  if (text) events.push({ type: 'markdown', text })
}

/** 确保状态里有这个制品的一份内容，已有的 HTML 与协议原文原样留着。 */
function ensureArtifactSnapshot(
  state: HtmlArtifactProtocolStreamState,
  artifact: HtmlArtifactDescriptor
): void {
  const existing = state.artifactsById[artifact.id]
  state.artifactsById[artifact.id] = {
    ...artifact,
    html: clipText(existing?.html ?? '', state.limits.maxArtifactHtmlLength),
    protocolText: clipText(
      existing?.protocolText ?? '',
      state.limits.maxArtifactProtocolTextLength
    ),
  }
}

/** 读一个制品当前攒下来的协议原文。 */
function readArtifactProtocolText(
  state: HtmlArtifactProtocolStreamState,
  artifact: HtmlArtifactDescriptor
): string {
  return state.artifactsById[artifact.id]?.protocolText ?? ''
}

/** 把一段原文追加到当前制品的协议原文上，按上限截断。 */
function appendArtifactProtocolText(state: HtmlArtifactProtocolStreamState, text: string): void {
  if (!state.activeArtifact || !text) return

  const artifact = state.activeArtifact
  const existing = state.artifactsById[artifact.id] ?? {
    ...artifact,
    html: '',
    protocolText: '',
  }
  state.artifactsById[artifact.id] = {
    ...existing,
    protocolText: clipText(
      `${existing.protocolText ?? ''}${text}`,
      state.limits.maxArtifactProtocolTextLength
    ),
  }
}

/** 换掉一个制品根节点的 HTML，并发一条更新事件。 */
function updateArtifactHtml(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  artifact: HtmlArtifactDescriptor,
  html: string,
  isStreaming: boolean
): void {
  const existing = state.artifactsById[artifact.id]
  const clippedHtml = clipText(html, state.limits.maxArtifactHtmlLength)
  state.artifactsById[artifact.id] = {
    ...artifact,
    html: clippedHtml,
    protocolText: existing?.protocolText ?? '',
  }
  events.push({
    type: 'artifact-update',
    artifact,
    html: clippedHtml,
    isStreaming,
    protocolText: readArtifactProtocolText(state, artifact),
  })
}

/** 从 `<artifact …>` 标签上读出制品身份；id 或版本不合法就返回 null。 */
function readArtifactFromTag(tag: ParsedProtocolTag): Nullable<HtmlArtifactDescriptor> {
  const rawId = tag.attributes.id ?? tag.attributes.artifactId
  if (!isString(rawId)) return null

  const id = normalizeExplicitArtifactId(rawId)
  if (!id) return null

  const protocolVersion = readArtifactProtocolVersion(tag.attributes.version)
  if (!protocolVersion) return null

  const title = clampArtifactTitle(tag.attributes.title ?? id)
  const initialHeight = parsePositiveHeight(toNullable(tag.attributes.height))
  const artifact = { id, protocolVersion, title }

  return isUndefined(initialHeight) ? artifact : { ...artifact, initialHeight }
}

/** 读 `<patch type="…">`：认不出的一律当整体替换。 */
function readActionType(tag: ParsedProtocolTag): HtmlArtifactActionType {
  switch (tag.attributes.type) {
    case 'append':
      return 'append'
    case 'style':
      return 'style'
    case 'script':
      return 'script'
    default:
      return 'replace'
  }
}

/** 归一化补丁的元数据（`target` / `id`）：去空白、按上限截断，空了当没写。 */
function normalizePatchMetadata(value: LooseOptional<string>): Optional<string> {
  if (!isString(value)) return undefined

  const normalized = value.trim().slice(0, HtmlArtifactProtocolLimitDefaults.maxPatchMetadataLength)
  return normalized || undefined
}

/** 读 `<patch encoding="…">`：只认 `base64`，别的当没编码。 */
function readActionEncoding(tag: ParsedProtocolTag): HtmlArtifactActionState['encoding'] {
  return tag.attributes.encoding === HtmlArtifactProtocolContract.base64Encoding
    ? HtmlArtifactProtocolContract.base64Encoding
    : undefined
}

/** 把缓冲区里确定不会是半个协议标签的那段前缀当 Markdown 发出去。 */
function emitSafeMarkdownPrefix(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const partialStart = findPartialProtocolStart(state.buffer, MARKDOWN_PARTIAL_PROTOCOL_CANDIDATES)

  if (partialStart < 0) {
    const text = state.buffer
    state.buffer = ''
    emitMarkdown(events, text)
    return
  }

  const text = state.buffer.slice(0, partialStart)
  state.buffer = state.buffer.slice(partialStart)
  emitMarkdown(events, text)
}

/** Markdown 模式：找到合法的 `<artifact …>` 就进制品模式，否则继续吐 Markdown。 */
function processMarkdownMode(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const openIndex = state.buffer.indexOf(ARTIFACT_OPEN)
  if (openIndex < 0) {
    emitSafeMarkdownPrefix(state, events)
    return
  }

  const before = state.buffer.slice(0, openIndex)
  emitMarkdown(events, before)
  const tagEnd = findTagEnd(state.buffer, openIndex)

  if (tagEnd < 0) {
    state.buffer = state.buffer.slice(openIndex)
    return
  }

  const tagText = state.buffer.slice(openIndex, tagEnd + 1)
  const parsedTag = parseTag(tagText, HtmlArtifactProtocolContract.artifactTag)

  if (!parsedTag) {
    emitMarkdown(events, tagText)
    state.buffer = state.buffer.slice(tagEnd + 1)
    return
  }

  const artifact = readArtifactFromTag(parsedTag)
  if (!artifact) {
    emitMarkdown(events, tagText)
    state.buffer = state.buffer.slice(tagEnd + 1)
    return
  }

  state.activeArtifact = artifact
  state.activeAction = null
  state.mode = 'artifact'
  state.buffer = state.buffer.slice(tagEnd + 1)
  ensureArtifactSnapshot(state, artifact)
  appendArtifactProtocolText(state, tagText)
  events.push({
    type: 'artifact-open',
    artifact,
    protocolText: readArtifactProtocolText(state, artifact),
  })
}

/** 制品模式：等 `<patch …>` 进补丁模式，或等 `</artifact>` 收尾。 */
function processArtifactMode(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const actionIndex = state.buffer.indexOf(PATCH_OPEN)
  const closeIndex = state.buffer.indexOf(ARTIFACT_CLOSE)
  const hasAction = actionIndex >= 0
  const hasClose = closeIndex >= 0

  if (!hasAction && !hasClose) {
    const partialStart = findPartialProtocolStart(state.buffer)
    state.buffer = partialStart >= 0 ? state.buffer.slice(partialStart) : ''
    return
  }

  if (hasClose && (!hasAction || closeIndex < actionIndex)) {
    const artifact = state.activeArtifact
    appendArtifactProtocolText(state, ARTIFACT_CLOSE)
    state.buffer = state.buffer.slice(closeIndex + ARTIFACT_CLOSE.length)
    state.activeArtifact = null
    state.activeAction = null
    state.mode = 'markdown'
    if (artifact) {
      events.push({
        type: 'artifact-close',
        artifact,
        protocolText: readArtifactProtocolText(state, artifact),
      })
    }
    return
  }

  const tagEnd = findTagEnd(state.buffer, actionIndex)
  if (tagEnd < 0) {
    state.buffer = state.buffer.slice(actionIndex)
    return
  }

  const tagText = state.buffer.slice(actionIndex, tagEnd + 1)
  const parsedTag = parseTag(tagText, HtmlArtifactProtocolContract.patchTag)
  if (!parsedTag) {
    state.buffer = state.buffer.slice(tagEnd + 1)
    return
  }

  const activeArtifact = state.activeArtifact
  appendArtifactProtocolText(state, tagText)
  state.activeAction = {
    type: readActionType(parsedTag),
    target: normalizePatchMetadata(parsedTag.attributes.target),
    styleId: normalizePatchMetadata(parsedTag.attributes.id),
    scriptId: normalizePatchMetadata(parsedTag.attributes.id),
    encoding: readActionEncoding(parsedTag),
    baseHtml: activeArtifact ? (state.artifactsById[activeArtifact.id]?.html ?? '') : '',
    html: '',
    emittedLength: 0,
    emittedDiagnostics: [],
  }
  state.mode = 'action'
  state.buffer = state.buffer.slice(tagEnd + 1)
}

/** 找出一段 HTML 里可以安全发出去的断点：闭合标签、自闭合标签、空标签与注释的结尾。 */
function findSafeHtmlEmitEnds(html: string, startIndex: number): number[] {
  const ends: number[] = []
  let searchIndex = Math.max(0, startIndex)

  while (searchIndex < html.length) {
    const openIndex = html.indexOf('<', searchIndex)
    if (openIndex < 0) break

    if (html.startsWith('<!--', openIndex)) {
      // 跳过 `<!--` 四个字符再找 `-->`，再跳过 `-->` 三个字符。
      const commentEnd = html.indexOf('-->', openIndex + 4)
      if (commentEnd < 0) break
      const endIndex = commentEnd + 3
      if (endIndex > startIndex) ends.push(endIndex)
      searchIndex = endIndex
      continue
    }

    const tagEnd = findHtmlTagEnd(html, openIndex)
    if (tagEnd < 0) break

    const tagText = html.slice(openIndex, tagEnd + 1)
    const tagMatch = tagText.match(/^<\/?\s*([A-Za-z][\w:-]*)\b/)
    const tagName = tagMatch?.[1]?.toLowerCase()
    const isClosingTag = /^<\//.test(tagText)
    const isSelfClosing = /\/\s*>$/.test(tagText)
    const isVoidTag = !!tagName && VOID_HTML_TAGS.has(tagName)
    const endIndex = tagEnd + 1

    if ((isClosingTag || isSelfClosing || isVoidTag) && endIndex > startIndex) {
      ends.push(endIndex)
    }

    searchIndex = endIndex
  }

  return ends
}

/** 找出一段 CSS 里可以安全发出去的断点：最外层规则块闭合的地方，引号与注释里的括号不算。 */
function findSafeCssEmitEnds(css: string, startIndex: number): number[] {
  const ends: number[] = []
  let quote: Nullable<string> = null
  let escaped = false
  let inComment = false
  let braceDepth = 0

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    const nextChar = css[index + 1]

    if (inComment) {
      if (char === '*' && nextChar === '/') {
        inComment = false
        index += 1
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = null
      continue
    }

    if (char === '/' && nextChar === '*') {
      inComment = true
      index += 1
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '{') {
      braceDepth += 1
      continue
    }

    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1
      if (braceDepth === 0 && index + 1 > startIndex) ends.push(index + 1)
    }
  }

  return ends
}

/** 把一串 UTF-8 字节解成字符串；认不出的字节位用替换字符顶上。 */
function decodeUtf8Bytes(bytes: number[]): string {
  let output = ''

  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index] ?? 0

    if (first < 0x80) {
      output += String.fromCharCode(first)
      continue
    }

    if (first >= 0xc0 && first < 0xe0) {
      const second = bytes[index + 1] ?? 0
      output += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f))
      index += 1
      continue
    }

    if (first >= 0xe0 && first < 0xf0) {
      const second = bytes[index + 1] ?? 0
      const third = bytes[index + 2] ?? 0
      output += String.fromCharCode(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
      )
      index += 2
      continue
    }

    if (first >= 0xf0 && first < 0xf8) {
      const second = bytes[index + 1] ?? 0
      const third = bytes[index + 2] ?? 0
      const fourth = bytes[index + 3] ?? 0
      const codePoint =
        ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f)
      output += String.fromCodePoint(codePoint)
      index += 3
      continue
    }

    output += '�'
  }

  return output
}

/** 解一段 Base64 载荷；出现字母表之外的字符就返回 null，交给调用方报诊断。 */
function decodeBase64Utf8(value: string): Nullable<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const normalized = value.replace(/\s+/g, '')
  const bytes: number[] = []
  let buffer = 0
  let bitCount = 0

  for (const char of normalized) {
    if (char === '=') break

    const nextValue = alphabet.indexOf(char)
    if (nextValue < 0) return null

    // 每个 Base64 字符携带 6 位，攒够 8 位就落一个字节。
    buffer = (buffer << 6) | nextValue
    bitCount += 6

    if (bitCount >= 8) {
      bitCount -= 8
      bytes.push((buffer >> bitCount) & 0xff)
    }
  }

  return decodeUtf8Bytes(bytes)
}

/** 取一次补丁动作对外说得出口的 id：脚本 id、样式 id、目标选择器，取第一个有值的。 */
function readActionPatchId(action: HtmlArtifactActionState): Optional<string> {
  return action.scriptId || action.styleId || action.target
}

/** 发一条解析期诊断；同一个指纹只发一次，不重复打扰宿主。 */
function emitActionDiagnostic(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  code: HtmlArtifactProtocolDiagnosticCode,
  message: string
): void {
  const artifact = state.activeArtifact
  const action = state.activeAction
  if (!artifact || !action) return

  const patchId = readActionPatchId(action)
  const diagnosticKey = `${code}:${action.type}:${patchId ?? ''}`
  if (action.emittedDiagnostics.includes(diagnosticKey)) return

  action.emittedDiagnostics.push(diagnosticKey)
  events.push({
    type: 'artifact-diagnostic',
    artifact,
    diagnostic: {
      code,
      message,
      phase: 'protocol',
      patchType: action.type,
      patchId,
    },
    protocolText: readArtifactProtocolText(state, artifact),
  })
}

/** 取出补丁载荷里到某个位置为止的内容；声明了 Base64 就先解码，解不开报诊断并原样返回。 */
function readActionPayload(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  action: HtmlArtifactActionState,
  endIndex: number
): string {
  const rawPayload = action.html.slice(0, endIndex)

  if (action.encoding !== HtmlArtifactProtocolContract.base64Encoding) return rawPayload

  const decoded = decodeBase64Utf8(rawPayload)
  if (isNotNull(decoded)) return decoded

  emitActionDiagnostic(
    state,
    events,
    'invalid-base64',
    `${action.type} 补丁的 base64 载荷解不开，按原文交付。`
  )
  return rawPayload
}

/** 把补丁载荷里到某个位置为止的内容发出去：样式、脚本、定点补丁各走各的事件，没有目标的打在制品根上。 */
function emitActionHtmlAtLength(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  endIndex: number,
  isStreaming: boolean
): void {
  const artifact = state.activeArtifact
  const action = state.activeAction
  if (!artifact || !action) return
  if (endIndex <= action.emittedLength) return

  const html = readActionPayload(state, events, action, endIndex)

  if (action.type === 'style') {
    events.push({
      type: 'artifact-patch',
      artifact,
      patch: {
        type: 'style',
        styleId: action.styleId || action.target || 'default',
        css: html,
      },
      protocolText: readArtifactProtocolText(state, artifact),
    })
    action.emittedLength = endIndex
    return
  }

  if (action.type === 'script') {
    events.push({
      type: 'artifact-patch',
      artifact,
      patch: {
        type: 'script',
        scriptId: action.scriptId || action.target || 'default',
        code: html,
      },
      protocolText: readArtifactProtocolText(state, artifact),
    })
    action.emittedLength = endIndex
    return
  }

  if (action.target) {
    events.push({
      type: 'artifact-patch',
      artifact,
      patch: {
        type: action.type,
        target: action.target,
        html:
          action.type === 'append' && action.encoding !== HtmlArtifactProtocolContract.base64Encoding
            ? action.html.slice(action.emittedLength, endIndex)
            : html,
      },
      protocolText: readArtifactProtocolText(state, artifact),
    })
    action.emittedLength = endIndex
    return
  }

  const rootHtml = action.type === 'append' ? `${action.baseHtml}${html}` : html
  updateArtifactHtml(state, events, artifact, rootHtml, isStreaming)
  action.emittedLength = endIndex
}

/** 把当前补丁载荷里所有已经安全的断点依次发出去；收尾那一次连最后一截一起发。 */
function emitSafeActionProgress(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  isStreaming: boolean,
  final: boolean
): void {
  const action = state.activeAction
  if (!action) return

  const safeEnds =
    action.encoding === HtmlArtifactProtocolContract.base64Encoding
      ? []
      : action.type === 'style'
        ? findSafeCssEmitEnds(action.html, action.emittedLength)
        : action.type === 'script'
          ? []
          : findSafeHtmlEmitEnds(action.html, action.emittedLength)
  const emitEnds = [...safeEnds]

  if (final && action.emittedLength < action.html.length) {
    const finalEnd = action.html.length
    if (emitEnds.at(-1) !== finalEnd) emitEnds.push(finalEnd)
  }

  for (const endIndex of emitEnds) {
    emitActionHtmlAtLength(state, events, endIndex, isStreaming)
  }
}

/** 往当前补丁载荷上追加一段，并把新凑出来的安全边界发出去。 */
function appendActionHtml(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[],
  htmlChunk: string,
  isStreaming: boolean,
  final = false,
  trackProtocol = true
): void {
  if (!htmlChunk && isStreaming && !final) return

  const action = state.activeAction
  if (!state.activeArtifact || !action) return

  if (trackProtocol) appendArtifactProtocolText(state, htmlChunk)
  action.html = clipText(`${action.html}${htmlChunk}`, state.limits.maxActionPayloadLength)
  emitSafeActionProgress(state, events, isStreaming, final)
}

/** 收掉当前这次补丁动作：把还没发的那一截发完。 */
function completePatchAction(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const action = state.activeAction
  if (!action) return

  emitSafeActionProgress(state, events, true, true)
  if (!action.target && action.type !== 'style') return
}

/** 补丁模式：遇到 `</patch>` 收掉这次补丁，遇到 `</artifact>` 连制品一起收掉。 */
function processActionMode(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  const closeIndex = state.buffer.indexOf(PATCH_CLOSE)
  const artifactCloseIndex = state.buffer.indexOf(ARTIFACT_CLOSE)

  if (artifactCloseIndex >= 0 && (closeIndex < 0 || artifactCloseIndex < closeIndex)) {
    const artifact = state.activeArtifact
    const htmlChunk = state.buffer.slice(0, artifactCloseIndex)
    appendArtifactProtocolText(state, `${htmlChunk}${ARTIFACT_CLOSE}`)
    appendActionHtml(state, events, htmlChunk, true, true, false)
    state.buffer = state.buffer.slice(artifactCloseIndex + ARTIFACT_CLOSE.length)
    state.activeAction = null
    state.activeArtifact = null
    state.mode = 'markdown'
    if (artifact) {
      events.push({
        type: 'artifact-close',
        artifact,
        protocolText: readArtifactProtocolText(state, artifact),
      })
    }
    return
  }

  if (closeIndex < 0) {
    const partialStart = findPartialProtocolStart(state.buffer)
    if (partialStart < 0) {
      const htmlChunk = state.buffer
      state.buffer = ''
      appendActionHtml(state, events, htmlChunk, true)
      return
    }

    const htmlChunk = state.buffer.slice(0, partialStart)
    state.buffer = state.buffer.slice(partialStart)
    appendActionHtml(state, events, htmlChunk, true)
    return
  }

  const htmlChunk = state.buffer.slice(0, closeIndex)
  appendArtifactProtocolText(state, `${htmlChunk}${PATCH_CLOSE}`)
  appendActionHtml(state, events, htmlChunk, true, true, false)
  state.buffer = state.buffer.slice(closeIndex + PATCH_CLOSE.length)
  state.activeAction = null
  state.mode = 'artifact'
}

/** 反复推进缓冲区，直到推不动或者用完这一轮的预算。 */
function processProtocolBuffer(
  state: HtmlArtifactProtocolStreamState,
  events: HtmlArtifactProtocolEvent[]
): void {
  let guard = 0

  while (state.buffer && guard < HtmlArtifactTuning.bufferPassesPerChunk) {
    guard += 1
    const previousMode = state.mode
    const previousBuffer = state.buffer

    if (state.mode === 'markdown') {
      processMarkdownMode(state, events)
    } else if (state.mode === 'artifact') {
      processArtifactMode(state, events)
    } else {
      processActionMode(state, events)
    }

    if (state.mode === previousMode && state.buffer === previousBuffer) break
  }
}

/** 新建一条流的解析状态；续读时把已有制品放回去，并按上限截断它们的内容。 */
export function createProtocolStreamState(
  options: HtmlArtifactProtocolStreamOptions = {}
): HtmlArtifactProtocolStreamState {
  const artifactsById: Record<string, HtmlArtifactSnapshot> = {}
  const limits = resolveProtocolLimits(options.limits)

  for (const artifact of options.initialArtifacts ?? []) {
    artifactsById[artifact.id] = {
      ...artifact,
      html: clipText(artifact.html, limits.maxArtifactHtmlLength),
      protocolText: artifact.protocolText
        ? clipText(artifact.protocolText, limits.maxArtifactProtocolTextLength)
        : artifact.protocolText,
    }
  }

  return {
    enabled: !!options.enabled,
    mode: 'markdown',
    buffer: '',
    activeArtifact: null,
    activeAction: null,
    artifactsById,
    anonymousArtifactCounter: 0,
    limits,
  }
}

/** 喂一段文本进来，吐出这一段能确定下来的事件；没开协议就整段当 Markdown 放过去。 */
export function applyProtocolChunk(
  state: HtmlArtifactProtocolStreamState,
  chunk: string
): HtmlArtifactProtocolEvent[] {
  if (!chunk) return []
  if (!state.enabled) return [{ type: 'markdown', text: chunk }]

  const events: HtmlArtifactProtocolEvent[] = []
  state.buffer += chunk
  processProtocolBuffer(state, events)
  state.buffer = clipTail(state.buffer, state.limits.maxBufferLength)
  return events
}

/** 流断在半路时收尾：把攒着的内容发完，制品一定会收到 `artifact-close`，状态回到 Markdown。 */
export function finalizeProtocolStream(
  state: HtmlArtifactProtocolStreamState
): HtmlArtifactProtocolEvent[] {
  if (!state.enabled) return []

  const events: HtmlArtifactProtocolEvent[] = []

  if (state.mode === 'action') {
    appendActionHtml(state, events, state.buffer, false)
    completePatchAction(state, events)
    state.buffer = ''
    state.activeAction = null
    if (state.activeArtifact) {
      events.push({
        type: 'artifact-close',
        artifact: state.activeArtifact,
        protocolText: readArtifactProtocolText(state, state.activeArtifact),
      })
    }
  } else if (state.mode === 'artifact') {
    if (state.activeArtifact) {
      appendArtifactProtocolText(state, state.buffer)
      events.push({
        type: 'artifact-close',
        artifact: state.activeArtifact,
        protocolText: readArtifactProtocolText(state, state.activeArtifact),
      })
    }
    state.buffer = ''
  } else if (state.buffer) {
    emitMarkdown(events, state.buffer)
    state.buffer = ''
  }

  state.mode = 'markdown'
  state.activeArtifact = null
  state.activeAction = null
  return events
}
