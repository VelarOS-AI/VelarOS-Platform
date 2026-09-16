/**
 * 查一个工具属于哪一页职责分类；没登记就当场抛错。
 *
 * 宁可装配时炸掉也不能让一个工具静默落进没人认识的分类：那样所有「按类别把门」的判定
 * 都会对它失灵，而现象只是「这个工具在目录里找不到」，排查起来毫无线索。
 */
export function requireBrowserToolCategoryId<Id extends string>(
  index: ReadonlyMap<string, Id>,
  toolName: string
): Id {
  const categoryId = index.get(toolName)
  if (!categoryId)
    throw new Error(
      `browser mod: 工具 ${toolName} 没有登记分类，请在 BrowserToolNamesByCategory 里补上。`
    )

  return categoryId
}
