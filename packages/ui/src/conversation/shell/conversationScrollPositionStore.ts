import { isFiniteNumber, isRecord, toNullable } from '#internal/runtime'
import { type TimerLease, TimerScope } from '#internal/timerScope'

/**
 * 每个会话的滚动位置：切走再切回、面板收起再打开，都回到上次看的位置，而不是一律跳到底。
 *
 * 跟随到底时每来一段流式内容都会滚一次、存一次——先记在内存里，合并成一次 localStorage 写入
 * （逐次同步写会让存储服务随 token 频率空转）；只保留最近用过的一批会话，数量有界；页面关闭前
 * 把没写的补上。宿主各用自己的存储键，互不串位。
 */
export interface ConversationScrollPositionStore {
  read(sessionId: string): Nullable<number>
  save(sessionId: string, scrollTop: number): void
  /** 立刻写入尚未落盘的位置。 */
  flush(): void
}

export interface ConversationScrollPositionStoreOptions {
  storageKey: string
  maxSessions?: number
  flushDelayMs?: number
  /** 缺省读 `globalThis.localStorage`；单测注入内存实现。 */
  storage?: () => Nullable<Pick<Storage, 'getItem' | 'setItem'>>
  now?: () => number
}

interface StoredScrollPosition {
  scrollTop: number
  updatedAt: number
}

const DefaultMaxSessions = 200
const DefaultFlushDelayMs = 400

export function createConversationScrollPositionStore(
  options: ConversationScrollPositionStoreOptions
): ConversationScrollPositionStore {
  const maxSessions = options.maxSessions ?? DefaultMaxSessions
  const flushDelayMs = options.flushDelayMs ?? DefaultFlushDelayMs
  const readStorage = options.storage ?? (() => toNullable(globalThis.localStorage))
  const now = options.now ?? Date.now
  const timers = new TimerScope({ name: `conversationScrollPositions:${options.storageKey}` })
  let positions: Nullable<Map<string, StoredScrollPosition>> = null
  let pendingFlush: Nullable<TimerLease> = null

  const load = (): Map<string, StoredScrollPosition> => {
    if (positions) return positions
    positions = new Map()
    try {
      const raw = readStorage()?.getItem(options.storageKey)
      const value: unknown = raw ? JSON.parse(raw) : null
      if (isRecord(value)) {
        for (const [sessionId, entry] of Object.entries(value)) {
          // 旧格式多一个 version 字段，照读。
          if (!isRecord(entry) || !isFiniteNumber(entry.scrollTop)) continue
          positions.set(sessionId, {
            scrollTop: Math.max(0, Math.floor(entry.scrollTop)),
            updatedAt: isFiniteNumber(entry.updatedAt) ? entry.updatedAt : 0,
          })
        }
      }
    } catch {
      // arch-guard:silent-catch-ok 读不到（被清理、格式坏了）就当没有记过位置。
    }
    return positions
  }

  const flush = (): void => {
    if (!pendingFlush) return
    pendingFlush.cancel()
    pendingFlush = null
    const entries = [...load()]
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, maxSessions)
    positions = new Map(entries)
    try {
      readStorage()?.setItem(options.storageKey, JSON.stringify(Object.fromEntries(entries)))
    } catch {
      // arch-guard:silent-catch-ok 写不进去只是下次回到底部，不影响聊天本身。
    }
  }

  globalThis.window?.addEventListener('pagehide', flush)

  return {
    read: (sessionId) => (sessionId ? toNullable(load().get(sessionId)?.scrollTop) : null),
    save: (sessionId, scrollTop) => {
      if (!sessionId) return
      load().set(sessionId, { scrollTop: Math.max(0, Math.floor(scrollTop)), updatedAt: now() })
      pendingFlush ??= timers.after(flushDelayMs, flush)
    },
    flush,
  }
}
