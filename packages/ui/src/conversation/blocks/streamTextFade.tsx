import React, {
  createContext,
  memo,
  type ReactElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react'

import {
  isArray,
  isEmpty,
  isFunction,
  isObject,
  isPresent,
  isString,
  toNullable,
} from '#internal/runtime'

/**
 * 流式文字淡入（正文 Markdown 与思考共用）。
 *
 * 打字节奏的唯一权威仍是状态层的 ChatStreamPacer；这里只决定「刚上屏的字」怎么显现：
 *  - 相隔很近上屏的字并成一批，每批包一个 span，淡入时长内同时只有个位数的 span；淡完的批次
 *    下一次渲染并回普通文本。
 *  - 每批记下第一次上屏的时刻（`performance.now` 时基），淡入进度只由「现在 − 上屏时刻」决定：
 *    用 Web Animations 的绝对 `startTime` 表达，组件重挂载、React 把元素复用给别的批次、StrictMode
 *    双调用都只会把进度对回同一时刻，不会从 0 重播。只动 opacity，不做 blur / transform / 逐字 span。
 *  - 账本按块记在模块级 LRU 里，只在提交后（layout effect）写入，被丢弃的渲染不污染它。
 *  - 第一次见到的块：消息视图已在屏上时，短的（刚开始的新段落）从头淡入；长的（首次打开已在跑的
 *    长消息）整段当作已显示。重挂载（切回会话）的第一帧只把还没淡完的批次接着淡完，离开期间到达的
 *    字、新起的段落都直接显示；之后新增的字才淡入——从构造上杜绝整段/整屏重播。
 *  - 系统开了「减少动态效果」就不淡入。
 */

/** 淡入时长。 */
export const StreamTextFadeDurationMs = 300
/** 相隔不到这么久上屏的字并进同一批，批数有上限，不随刷新率线性增长。 */
const StreamTextFadeBatchMs = 48
/** 第一次见到的块不超过这么长（按源文本计）才从头淡入。 */
const StreamTextFadeNewBlockMaxChars = 48

/** 同一批上屏的一段字：`[start, end)` 是它在块内可淡入文字里的偏移。 */
export interface StreamFadeChunk {
  readonly start: number
  readonly end: number
  /** 第一次上屏的时刻（`performance.now` / `document.timeline` 时基）。 */
  readonly bornAt: number
}

export interface StreamFadeLedger {
  /** 已经上过屏的可淡入文字长度。 */
  readonly length: number
  /** 还没淡完的批次，按 `start` 升序、首尾相接。 */
  readonly chunks: readonly StreamFadeChunk[]
}

export interface StreamFadeTextPiece {
  readonly text: string
  /** 这一段在块内可淡入文字里的起点；淡入段拿它当 React key。 */
  readonly start: number
  /** 淡入段的上屏时刻；`null` 是已沉淀的普通文本。 */
  readonly bornAt: Nullable<number>
}

const NoStreamFadeChunks: readonly StreamFadeChunk[] = []

/** 淡入时钟：与 Web Animations 的 `document.timeline` 同一时基。 */
export function readStreamFadeClock(): number {
  return globalThis.performance?.now() ?? Date.now()
}

/**
 * 这一次渲染的淡入计划：账本里还没淡完的批次，加上装「这次新出现的字」的开口批次
 * （`end = Infinity`）；上一批刚开始不久就把新字并进去。
 */
export function planStreamFade({
  ledger,
  now,
  sourceLength,
  mounted,
  viewLive = true,
}: {
  ledger: Optional<StreamFadeLedger>
  now: number
  /** 块的源文本长度，只用来判断第一次见到的块算不算「刚开始」。 */
  sourceLength: number
  /** 这个视图已经提交过这个块（不是挂载后的第一帧）。 */
  mounted: boolean
  /** 所在消息视图已经在屏上（见 {@link StreamFadeViewContext}）；否则第一次见到的块一律当已显示。 */
  viewLive?: boolean
}): readonly StreamFadeChunk[] {
  if (!ledger)
    return viewLive && sourceLength <= StreamTextFadeNewBlockMaxChars
      ? [{ start: 0, end: Number.POSITIVE_INFINITY, bornAt: now }]
      : NoStreamFadeChunks

  const live = ledger.chunks.filter((chunk) => now - chunk.bornAt < StreamTextFadeDurationMs)
  if (!mounted) return live
  const last = live.at(-1)
  if (last && last.end >= ledger.length && now - last.bornAt < StreamTextFadeBatchMs)
    return [...live.slice(0, -1), { ...last, end: Number.POSITIVE_INFINITY }]
  return [...live, { start: ledger.length, end: Number.POSITIVE_INFINITY, bornAt: now }]
}

/** 渲染提交后写回账本：开口批次收口到实际长度，空批次丢掉。 */
export function settleStreamFade(
  chunks: readonly StreamFadeChunk[],
  textLength: number
): StreamFadeLedger {
  const settled = chunks.flatMap((chunk) => {
    const end = Math.min(chunk.end, textLength)
    return end > chunk.start ? [{ ...chunk, end }] : []
  })
  return { length: textLength, chunks: settled }
}

/** 把一段位于 `textStart` 的文字按批次切开；不落在任何批次里的部分是普通文本。 */
export function splitStreamFadeText(
  text: string,
  textStart: number,
  chunks: readonly StreamFadeChunk[]
): StreamFadeTextPiece[] {
  const textEnd = textStart + text.length
  const pieces: StreamFadeTextPiece[] = []
  let cursor = textStart
  for (const chunk of chunks) {
    if (chunk.end <= cursor) continue
    if (chunk.start >= textEnd) break
    const from = Math.max(chunk.start, cursor)
    if (from > cursor)
      pieces.push({ text: text.slice(cursor - textStart, from - textStart), start: cursor, bornAt: null })
    const to = Math.min(chunk.end, textEnd)
    pieces.push({ text: text.slice(from - textStart, to - textStart), start: from, bornAt: chunk.bornAt })
    cursor = to
  }
  if (cursor < textEnd || isEmpty(pieces))
    pieces.push({ text: text.slice(cursor - textStart), start: cursor, bornAt: null })
  return pieces
}

/** 刚诞生的回答挂载时最多已有这么多字（起搏器一两帧的量）；再多就是切回来重新挂载的。 */
const StreamFadeLiveBornMaxChars = 24

/**
 * 消息视图是否已经在屏上。切回会话时整条消息重新挂载，这一帧里第一次见到的块都是离开期间写出来的，
 * 不从头淡入；视图提交过之后新出现的块（新段落、新思考块）才从头淡入。刚诞生的回答挂载时本来就在屏上。
 */
export interface StreamFadeViewState {
  live: boolean
}

export const StreamFadeViewContext = createContext<Nullable<StreamFadeViewState>>(null)

/** 每条消息一份，引用稳定；子块在渲染期读 `live`，消息首次提交后置真（layout effect 自下而上，子块先提交）。 */
export function useStreamFadeViewState({
  streaming,
  readTextLength,
}: {
  streaming: boolean
  /** 只在挂载时读一次：消息此刻已有的正文与思考字数。 */
  readTextLength: () => number
}): StreamFadeViewState {
  const stateRef = useRef<Nullable<StreamFadeViewState>>(null)
  if (!stateRef.current)
    stateRef.current = { live: streaming && readTextLength() <= StreamFadeLiveBornMaxChars }
  const state = stateRef.current

  useLayoutEffect(() => {
    state.live = true
  }, [state])

  return state
}

export interface StreamFadeLedgerStore {
  get(key: string): Optional<StreamFadeLedger>
  set(key: string, ledger: StreamFadeLedger): void
}

/** 按块记账本的 LRU：模块级，跨重挂载保留，条数有上限。 */
export function createStreamFadeLedgerStore(maxEntries: number): StreamFadeLedgerStore {
  const ledgers = new Map<string, StreamFadeLedger>()
  return {
    get: (key) => ledgers.get(key),
    set(key, ledger) {
      ledgers.delete(key)
      if (ledgers.size >= maxEntries) {
        const oldestKey = ledgers.keys().next().value
        if (isString(oldestKey)) ledgers.delete(oldestKey)
      }
      ledgers.set(key, ledger)
    },
  }
}

const reducedMotion: { resolved: boolean; query: Nullable<MediaQueryList> } = {
  resolved: false,
  query: null,
}

function prefersReducedMotion(): boolean {
  if (!reducedMotion.resolved) {
    reducedMotion.resolved = true
    reducedMotion.query = toNullable(
      globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')
    )
  }
  return !!reducedMotion.query?.matches
}

const StreamFadeKeyframes: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }]
const StreamFadeTiming: KeyframeAnimationOptions = {
  duration: StreamTextFadeDurationMs,
  easing: 'ease-out',
  fill: 'backwards',
}

/** 一批正在淡入的字。进度只由 `bornAt` 决定，见文件头。 */
function StreamFadeTextInner({
  bornAt,
  children,
}: {
  bornAt: number
  children?: ReactNode
}): ReactElement {
  const elementRef = useRef<HTMLSpanElement>(null)
  const animationRef = useRef<Nullable<Animation>>(null)

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || !isFunction(element.animate) || prefersReducedMotion()) return
    // 已经淡完的批次（重挂载时常见）不必再建动画。
    if (!animationRef.current && readStreamFadeClock() - bornAt >= StreamTextFadeDurationMs) return

    const animation = animationRef.current ?? element.animate(StreamFadeKeyframes, StreamFadeTiming)
    animationRef.current = animation
    animation.startTime = bornAt
  }, [bornAt])

  useLayoutEffect(
    () => () => {
      animationRef.current?.cancel()
      animationRef.current = null
    },
    []
  )

  return (
    <span ref={elementRef} data-velar-stream-fade="">
      {children}
    </span>
  )
}

/** 正在长的段落每帧都会重渲染它的文字节点；批次本身没变（同一段字、同一个上屏时刻）就不重渲染。 */
export const StreamFadeText = memo(StreamFadeTextInner)
StreamFadeText.displayName = 'StreamFadeText'

/** 按批次渲染一段文字：没有落进批次的部分原样输出，淡入段以批次起点为 key，身份稳定。 */
export function renderStreamFadeText(
  text: string,
  textStart: number,
  chunks: readonly StreamFadeChunk[]
): ReactNode {
  const pieces = splitStreamFadeText(text, textStart, chunks)
  if (pieces.length === 1 && !isPresent(pieces[0].bornAt)) return text

  return pieces.map((piece) =>
    isPresent(piece.bornAt) ? (
      <StreamFadeText key={piece.start} bornAt={piece.bornAt}>
        {piece.text}
      </StreamFadeText>
    ) : (
      piece.text
    )
  )
}

// ---- Streamdown（正文 Markdown）接线 ----

/** 插件给文本节点套上的标签；由 {@link StreamFadeMarkdownText} 接管渲染，DOM 里不出现它。 */
export const StreamFadeMarkdownTextTagName = 'velar-stream-text'
const StreamFadeExcludedTagNames = new Set(['code', 'pre', 'svg', 'math', 'annotation', 'script', 'style'])

interface StreamFadeHastNode {
  type?: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: StreamFadeHastNode[]
}

function isStreamFadeHastNode(value: unknown): value is StreamFadeHastNode {
  return isObject(value)
}

function isStreamFadeExcludedElement(node: StreamFadeHastNode): boolean {
  if (node.type !== 'element') return false
  if (StreamFadeExcludedTagNames.has(node.tagName ?? '')) return true
  const className = node.properties?.className
  return isArray(className) && className.some((name) => isString(name) && name.startsWith('katex'))
}

function markStreamFadeText(node: StreamFadeHastNode, cursor: { textLength: number }): void {
  if (!node.children || isStreamFadeExcludedElement(node)) return

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    if (child.type !== 'text') {
      markStreamFadeText(child, cursor)
      continue
    }
    const value = child.value ?? ''
    const start = cursor.textLength
    cursor.textLength += value.length
    // 纯空白（表格、列表结构里的换行）保持原样：它们不能被包进元素。
    if (!/\S/u.test(value)) continue
    node.children[index] = {
      type: 'element',
      tagName: StreamFadeMarkdownTextTagName,
      properties: { dataVelarStreamStart: start },
      children: [child],
    }
  }
}

/**
 * 给每个非空白文本节点标上它在本块可淡入文字里的起点。**必须无状态**：Streamdown 按插件函数名
 * 缓存 unified 处理器，所有块共用同一个处理器，插件里捕获的任何块状态都会串到别的块上。
 * 切分交给渲染期的 {@link StreamFadeMarkdownText}，它从 context 里拿本块的计划。
 */
export function velarStreamFadeTextPlugin() {
  return (tree: unknown): void => {
    if (isStreamFadeHastNode(tree)) markStreamFadeText(tree, { textLength: 0 })
  }
}

export interface StreamFadeRenderScope {
  readonly chunks: readonly StreamFadeChunk[]
  /** 本次渲染里各文本节点报上来的末尾偏移；提交后记进账本。 */
  readonly report: { textLength: number }
}

export const StreamFadeRenderScopeContext = createContext<Nullable<StreamFadeRenderScope>>(null)

export function StreamFadeMarkdownText(props: {
  'data-velar-stream-start'?: number | string
  children?: ReactNode
}): ReactNode {
  const scope = useContext(StreamFadeRenderScopeContext)
  const { children } = props
  if (!scope || !isString(children)) return toNullable(children)

  const start = Number(props['data-velar-stream-start']) || 0
  scope.report.textLength = Math.max(scope.report.textLength, start + children.length)
  return renderStreamFadeText(children, start, scope.chunks)
}
