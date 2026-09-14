import { isUndefined } from '@velaros-ai/core'

/** 单个进程内最多保留的 glob 编译结果数量，避免用户提供的 pattern 令缓存无界增长。 */
export const MatcherCacheCapacity = 256;

type Matcher = (input: string) => boolean;
type MatcherCompiler = (pattern: string) => Matcher;

/**
 * 创建固定容量的 LRU matcher 缓存。命中项会被移到队尾，超限时淘汰最久未使用项。
 */
export function createMatcherCache(capacity: number, compile: MatcherCompiler): MatcherCompiler {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("Matcher cache capacity must be a positive integer");
  }

  const cache = new Map<string, Matcher>();
  return (pattern) => {
    const cached = cache.get(pattern);
    if (cached) {
      cache.delete(pattern);
      cache.set(pattern, cached);
      return cached;
    }

    // 先编译再淘汰；无效 pattern 抛错时不应冲掉一个仍可复用的 matcher。
    const matcher = compile(pattern);
    if (cache.size >= capacity) {
      const oldestPattern = cache.keys().next().value;
      if (!isUndefined(oldestPattern)) cache.delete(oldestPattern);
    }
    cache.set(pattern, matcher);
    return matcher;
  };
}
