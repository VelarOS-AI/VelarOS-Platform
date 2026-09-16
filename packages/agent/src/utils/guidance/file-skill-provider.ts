// FileSkillProvider 用到的纯函数（不碰实例状态）。
/**
 * 用户技能默认排序优先级：故意低于内置 catalog 的 100（priority 升序=靠前）。
 * 用户显式安装的技能承载明确意图，索引 12 条截断时应先于泛化内置技能展示。
 * frontmatter `priority:` 可覆盖。
 */
export function resolveFileSkillScopes(spaces: readonly string[]): string[] {
  return spaces
    .map((space) => space.trim().toLowerCase())
    .filter(Boolean)
}
