/**
 * 会话级前缀缓存键：会话 id 的 SHA-256 取前 16 字节，写成 32 位十六进制。
 *
 * 会话 id 长度不定（子任务是 `agent:<父会话>:<uuid>`，还会层层嵌套），OpenAI 的 `prompt_cache_key`
 * 超过 64 个字符整次请求直接 400。摘要定长，同一会话重启后不变，也不把会话名发给供应商。
 */
export async function sessionCacheKey(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId))
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
