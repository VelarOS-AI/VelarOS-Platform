// CodingSessionTracker 用到的纯函数（不碰实例状态）。
/** 把资源标识归一成仓库内的相对路径；越界（含 ..）或空串一律不入账。 */
export function normalizeResourceIdForTracker(raw: string): LooseOptional<string> {
  const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!rel || rel.includes('..')) return null
  return rel
}
