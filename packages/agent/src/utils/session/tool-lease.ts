/**
 * 这次「启用工具类别」要不要顺带发一张按轮次到期的临时租约。
 *
 * 判据只看调用方给的理由文本：模型自己 page-in（tooling:replace 之类）要租约，到期自动换出；
 * 由运行档位（`run profile ...`）整体铺开的类别不要租约——那是档位声明的常驻面，被轮次租约收走会让
 * 模型下一轮突然看不见本该一直在的工具。没写理由一律不发租约。
 */
export function shouldTrackDynamicToolCategoryLease(reason?: string): boolean {
  const normalized = reason?.trim()
  if (!normalized) return false
  return !normalized.toLowerCase().startsWith('run profile ')
}
