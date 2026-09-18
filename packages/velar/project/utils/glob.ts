/**
 * 路径 glob：项目里的每一次规则匹配都经这里。规则引擎在 `@velaros-ai/path-rules`，本文件只钉住项目自己的那条约定——按盘的大小写规矩比。
 */

import { pathMatcher } from '@velaros-ai/path-rules'
import { currentPlatform } from '@velaros-ai/platform'

/**
 * 本平台的路径比较区不区分大小写：macOS 与 Windows 的卷缺省不区分，`.ENV` 和 `.env` 是同一个文件。
 * include/exclude 按同一个身份判，大小写变体不会漏掉。
 */
const PathComparisonIsCaseSensitive = !(currentPlatform.isMacOS() || currentPlatform.isWindows())

/**
 * 判断路径是否命中任一匹配规则：规则以 `/` 结尾按目录前缀，不含通配按精确或目录前缀，其余交给 picomatch（否定、字符类、分组、扩展通配都认）。
 * 大小写按本平台的盘规矩，大小写不敏感的盘上 `.ENV` 命中 `.env`。
 */
export function matchesAny(path: string, patterns: readonly string[] = []): boolean {
  return pathMatcher.matchesAny(path, patterns, { caseSensitive: PathComparisonIsCaseSensitive })
}
