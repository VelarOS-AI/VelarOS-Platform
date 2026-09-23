/**
 * 只读集合快照：`Object.freeze(new Set())` 仍然可以 `add`，所以对外发布的集合要用不带写入 API 的门面。
 *
 * 返回的对象只有 `ReadonlySet` 的成员，拿到它的人既改不了内容，也拿不到内部的 `Set`。
 */
export function createReadonlySetSnapshot<T>(values: Iterable<T>): ReadonlySet<T> {
  const items = new Set(values)
  const snapshot: ReadonlySet<T> = Object.freeze({
    get size(): number {
      return items.size
    },
    has: (value: T) => items.has(value),
    entries: () => items.entries(),
    keys: () => items.keys(),
    values: () => items.values(),
    forEach: (
      callback: (value: T, valueAgain: T, set: ReadonlySet<T>) => void,
      thisArg?: unknown
    ) => {
      for (const value of items) callback.call(thisArg, value, value, snapshot)
    },
    [Symbol.iterator]: () => items[Symbol.iterator](),
  })

  return snapshot
}

/** 只读映射快照：和 {@link createReadonlySetSnapshot} 同样的道理，出包的查表不许带 `set` 与 `delete`。 */
export function createReadonlyMapSnapshot<K, V>(
  entries: Iterable<readonly [K, V]>
): ReadonlyMap<K, V> {
  const items = new Map(entries)
  const snapshot: ReadonlyMap<K, V> = Object.freeze({
    get size(): number {
      return items.size
    },
    get: (key: K) => items.get(key),
    has: (key: K) => items.has(key),
    entries: () => items.entries(),
    keys: () => items.keys(),
    values: () => items.values(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      for (const [key, value] of items) callback.call(thisArg, value, key, snapshot)
    },
    [Symbol.iterator]: () => items[Symbol.iterator](),
  })

  return snapshot
}
