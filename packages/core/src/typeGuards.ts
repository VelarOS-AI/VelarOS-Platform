/**
 * 集中实现常用运行时类型判断（含 null / undefined 与 **boolean / string / number / function / bigint / symbol / object / 数组**）。
 *
 * - 所有守卫都是 ESM 具名导出，不修改 `globalThis`。
 * - **`TypeGuards`** 命名空间适合当值传递；一般调用可直接具名导入 **`isPresent` / `isString`**。
 * - 业务代码禁止直接写 `=== null` / `!== null` / `=== undefined` / `!== undefined`（见 arch-guard），应使用上述守卫。
 * - 宽松 **`== null`** / **`!= null`** / **`== undefined`** / **`!= undefined`**（nullish）：分别用 **`!isPresent(...)`** / **`isPresent(...)`**；仅在**严格只要识别 `null`** 时用 **`isNull`** / **`isNotNull`**。
 *
 * **`isRecord`**：`typeof value === 'object'` 且非 `null`、非数组（常用于 JSON/Record 形态）；**`isPlainObject`** 为同实现别名；**`isObject`**：含数组、`Date` 等一切非 null 的 object。
 * **`isFiniteNumber`**：`typeof value === 'number' && Number.isFinite(value)`（排除 `NaN` / `±Infinity`）。
 */
import { isEmpty } from './utils/array.js'
const isRecordGuard = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const VelarosTypeGuardName = Symbol.for('velaros.typeGuard.name')

export const VelarosRuntimeTypeGuardNames = [
  'isNull',
  'isNotNull',
  'isUndefined',
  'isNotUndefined',
  'isPresent',
  'isBoolean',
  'isTrue',
  'isFalse',
  'isString',
  'isNonBlankString',
  'isNumber',
  'isPositiveNumber',
  'isFiniteNumber',
  'isFunction',
  'isBigInt',
  'isSymbol',
  'isObject',
  'isRecord',
  'isPlainObject',
  'isArray',
  'isNonEmptyArray',
] as const

export type VelarosRuntimeTypeGuardName = (typeof VelarosRuntimeTypeGuardNames)[number]

export const TypeGuards = {
  isNull(value: unknown): value is null {
    return value === null
  },

  isNotNull<T>(value: Nullable<T>): value is T {
    return value !== null
  },

  isUndefined(value: unknown): value is undefined {
    return value === undefined
  },

  isNotUndefined<T>(value: T | undefined): value is T {
    return value !== undefined
  },

  /** 同时排除 `null` 与 `undefined`（`value != null`，宽松相等）。 */
  isPresent<T>(value: T): value is NonNullable<T> {
    return value != null
  },

  isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean'
  },

  /** `value === true`。用于三值 boolean 边界里表达“明确为 true”。 */
  isTrue(value: unknown): value is true {
    return value === true
  },

  /** `value === false`。用于三值 boolean 边界里表达“明确为 false”。 */
  isFalse(value: unknown): value is false {
    return value === false
  },

  isString(value: unknown): value is string {
    return typeof value === 'string'
  },

  isNumber(value: unknown): value is number {
    return typeof value === 'number'
  },

  /** `typeof value === 'number' && value > 0`。 */
  isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && value > 0
  },

  /** `typeof value === 'number'` 时返回自身，否则 `null`（与 `isNumber(value) ? value : null`、`typeof value === 'number' ? value : null` 等价；含 `NaN`）。 */
  numberOrNull(value: unknown): Nullable<number> {
    return typeof value === 'number' ? value : null
  },

  /** `typeof value === 'string'` 且 **trim 后非空**（与 `isString(value) && !!value.trim()`、`typeof value === 'string' && !!value.trim()` 等价）。 */
  isNonBlankString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  },

  /** 为 string 时 **trim**，否则 **`''`**（与 `isString(value) ? value.trim() : ''`、`typeof value === 'string' ? value.trim() : ''` 等价）。 */
  trimmedStringOrEmpty(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
  },

  /** `typeof value === 'number' && Number.isFinite(value)`（排除 `NaN` / `±Infinity`）。 */
  isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
  },

  isFunction(value: unknown): value is Function {
    return typeof value === 'function'
  },

  isBigInt(value: unknown): value is bigint {
    return typeof value === 'bigint'
  },

  isSymbol(value: unknown): value is symbol {
    return typeof value === 'symbol'
  },

  /** `typeof value === 'object' && value !== null`（含数组、Date 等）。 */
  isObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null
  },

  /** 非 null 的 object 且非数组（字典 / JSON 对象常用）。 */
  isRecord: isRecordGuard,

  /** {@link isRecord} 的历史别名。 */
  isPlainObject: isRecordGuard,

  isArray(value: unknown): value is unknown[] {
    return Array.isArray(value)
  },

  /** `Array.isArray(value)` 且长度非零。 */
  isNonEmptyArray(value: unknown): value is unknown[] {
    return Array.isArray(value) && !isEmpty(value)
  },
} as const

type BrandedTypeGuardFunction = Function & {
  [VelarosTypeGuardName]?: VelarosRuntimeTypeGuardName
}

for (const name of VelarosRuntimeTypeGuardNames) {
  const guard = TypeGuards[name] as BrandedTypeGuardFunction
  if (VelarosTypeGuardName in guard) continue
  Object.defineProperty(guard, VelarosTypeGuardName, {
    value: name,
    enumerable: false,
    configurable: false,
  })
}

export const {
  isNull,
  isNotNull,
  isUndefined,
  isNotUndefined,
  isPresent,
  isBoolean,
  isTrue,
  isFalse,
  isString,
  isNonBlankString,
  trimmedStringOrEmpty,
  isNumber,
  isPositiveNumber,
  numberOrNull,
  isFiniteNumber,
  isFunction,
  isBigInt,
  isSymbol,
  isObject,
  isRecord,
  isPlainObject,
  isArray,
  isNonEmptyArray,
} = TypeGuards

export type VelarTypeGuards = typeof TypeGuards
