/**
 * 命令行参数的解析与取值。只认 `--name value`、`--name=value` 与裸旗标三种写法。
 */
import type { ParsedArguments } from '../types/internal.js'

/** 把一串 argv 拆成子命令、位置参数与旗标。 */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command = null, ...rest] = argv
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const [rawName, inlineValue] = value.slice(2).split('=', 2)
    const next = rest[index + 1]
    if (inlineValue !== undefined) flags[rawName] = inlineValue
    else if (next && !next.startsWith('--')) {
      flags[rawName] = next
      index += 1
    } else flags[rawName] = true
  }
  return { command, positionals, flags }
}

/** 取一个必须给的旗标；没给或给了空串就报错（中文，旗标名原样）。 */
export function requiredFlag(parsed: ParsedArguments, name: string): string {
  const value = parsed.flags[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`缺少必填参数 --${name}`)
  return value
}

/** 取一个可给可不给的旗标；没给或只是个裸旗标就是 `null`。 */
export function optionalFlag(parsed: ParsedArguments, name: string): string | null {
  const value = parsed.flags[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 取一个数字旗标；没给就用调用方给的缺省值，给了但不是数字就报错。 */
export function numberFlag(parsed: ParsedArguments, name: string, fallback: number): number {
  const value = optionalFlag(parsed, name)
  if (value === null) return fallback
  const parsedNumber = Number(value)
  if (!Number.isFinite(parsedNumber)) throw new Error(`参数 --${name} 不是一个数字: ${value}`)
  return parsedNumber
}
