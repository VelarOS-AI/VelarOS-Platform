export type CatalogLocale = 'en-US' | 'zh-CN'

export function isEmpty(value: string | readonly unknown[] | null | undefined): boolean {
  return value == null || value.length === 0
}

export function optionalWhen<T>(condition: unknown, value: T): T | undefined {
  return condition === true ? value : undefined
}

export function toNullable<T>(value: T | undefined): T | null {
  return value ?? null
}

export function toOptional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}
