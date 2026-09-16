/**
 * glob 规则的形状判断：有没有通配特殊字符、是不是「某个目录下面的一切」。
 */

/** pattern 里有没有通配特殊字符（`*`、`?`、`[`、`]`、`{`、`}`、`!`、`(`、`)`）。 */
export function hasGlobMagic(pattern: string): boolean {
  return /[*?[\]{}!()]/.test(pattern)
}

/** 形如 `dir/**` 且 `dir` 部分不含通配符时返回 `dir`，按目录前缀匹配；否则返回 null。 */
export function directoryGlobBase(pattern: string): Nullable<string> {
  if (!pattern.endsWith('/**')) return null
  const base = pattern.slice(0, -3)
  return hasGlobMagic(base) ? null : base
}
