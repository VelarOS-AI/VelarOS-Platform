import picomatch from "picomatch";

import { createMatcherCache } from "./matcher-cache.js";
import { normalizeRel } from "./path.js";
import { ProjectTuning } from "./tuning.js";

/** 按 pattern 缓存编译好的 picomatch 匹配器（匹配点开头的文件、区分大小写），容量见 ProjectTuning.glob.matcherCacheEntries。 */
const getMatcher = createMatcherCache(ProjectTuning.glob.matcherCacheEntries, (pattern) =>
  picomatch(pattern, { dot: true, nocase: false }),
);

/** pattern 里有没有通配特殊字符（* ? [ ] { } ! ( )）。 */
function hasGlobMagic(pattern: string): boolean {
  return /[*?[\]{}!()]/.test(pattern);
}

/** 形如 dir/** 且 dir 部分不含通配符时返回 dir，按目录前缀匹配；否则返回 null。 */
function directoryGlobBase(pattern: string): Nullable<string> {
  if (!pattern.endsWith("/**")) return null;
  const base = pattern.slice(0, -3);
  return hasGlobMagic(base) ? null : base;
}

/**
 * 把 glob pattern 编译为正则，**仅**用于历史调用方需要直接拿 RegExp 的场景。
 *
 * 新代码请优先使用 `matchesAny`，它复用 picomatch 编译并保留目录前缀语义。
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeRel(pattern);
  if (!normalized) return /^$/;
  return picomatch.makeRe(normalized, { dot: true });
}

/**
 * 判断路径是否命中任一匹配规则，保留工作区既有的目录前缀、精确相等和通配匹配语义：
 *
 *  1. 规则以 `/` 结尾时，按目录前缀匹配；
 *  2. 规则不含通配特殊字符时，按精确相等或目录前缀匹配；
 *  3. 其它（含 *、?、[ ]、{ }、! 等）→ 走 picomatch 全功能匹配。
 *
 * 升级到 picomatch 后，第 3 类规则支持否定、字符类、分组和扩展通配等更丰富语法。
 */
export function matchesAny(path: string, patterns: readonly string[] = []): boolean {
  const target = normalizeRel(path);
  return patterns.some((pattern) => {
    const normalized = normalizeRel(pattern);
    if (normalized.endsWith("/")) return target.startsWith(normalized);
    const directoryBase = directoryGlobBase(normalized);
    if (directoryBase) return target === directoryBase || target.startsWith(`${directoryBase}/`);
    if (!hasGlobMagic(normalized)) return target === normalized || target.startsWith(`${normalized}/`);
    return getMatcher(normalized)(target);
  });
}
