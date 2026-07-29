/** 仅用于声明公共 API 的空值联合类型。 */
export type Nullish = undefined | null

/** 仅允许 `null` 的可空值。 */
export type Nullable<T> = T | null

/** 无原型约束的普通键值对象。 */
export type PlainObject = Record<string, unknown>

/** `JSON.stringify` 支持的 replacer 形态。 */
export type JsonStringifyReplacerValue =
  | ((this: any, key: string, value: any) => any)
  | Array<string | number>

/** 可空的 `JSON.stringify` replacer。 */
export type JsonStringifyReplacer = Nullable<JsonStringifyReplacerValue>

/** 可省略、可为 `null` 的兼容输入。新 API 优先使用明确的可选属性。 */
export type LooseOptional<T> = T | Nullish
