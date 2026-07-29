/**
 * Shared compile-time-only VelarOS type aliases used by Model Runtime.
 * Runtime helpers remain explicit imports from @velaros-ai/core.
 */
type Nullish = undefined | null
type Nullable<T> = T | null
type PlainObject = Record<string, unknown>
type JsonStringifyReplacerValue =
  | ((this: any, key: string, value: any) => any)
  | Array<string | number>
type JsonStringifyReplacer = Nullable<JsonStringifyReplacerValue>
type LooseOptional<T> = T | Nullish
