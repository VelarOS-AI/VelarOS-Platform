import { isEmpty } from '@velaros-ai/core'

export type NamedImportRemoval =
  | { status: 'not_found' }
  | { status: 'remove_statement' }
  | { status: 'updated'; statement: string }

/**
 * 从一条 ESM import 语句中删除指定 named binding。
 * 返回 remove_statement 表示该语句只剩空 named 列表；存在 default binding 时会保留 default import。
 */
export function removeNamedImportBinding(
  statement: string,
  importedName: string,
): NamedImportRemoval {
  const braceMatch = /\{([^}]*)\}/.exec(statement)
  if (!braceMatch || braceMatch.index < 0) return { status: 'not_found' }

  const bindings = braceMatch[1]
    .split(',')
    .map((binding) => binding.trim())
    .filter(Boolean)
  const retained = bindings.filter((binding) => {
    const imported = binding.split(/\s+as\s+/i, 1)[0]?.trim()
    return imported !== importedName
  })
  if (retained.length === bindings.length) return { status: 'not_found' }
  if (!isEmpty(retained)) return {
      status: 'updated',
      statement: `${statement.slice(0, braceMatch.index)}{ ${retained.join(', ')} }${statement.slice(braceMatch.index + braceMatch[0].length)}`,
    }

  const beforeBindings = statement.slice(0, braceMatch.index).replace(/,\s*$/, '').trimEnd()
  const afterBindings = statement.slice(braceMatch.index + braceMatch[0].length)
  // beforeBindings 已 trimEnd，纯 named import 只剩 `import` 或 `import type`。
  if (/^import(?:\s+type)?$/i.test(beforeBindings)) return { status: 'remove_statement' }
  return {
    status: 'updated',
    statement: `${beforeBindings}${afterBindings}`,
  }
}
