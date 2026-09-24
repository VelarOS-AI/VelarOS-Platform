import { isPlainObject, isString, Log } from '@velaros-ai/core'

/**
 * 本帧的环境：宿主条目加上运行时自己读的当地时钟。time 是带时区偏移的 ISO 时间，
 * localTime 是带星期的当地时间；这三项由运行时填写，宿主同名条目不生效。
 * 宿主条目读取失败或形状不对时只给时钟，不让一次环境读取挡住模型请求。
 */
export function frameEnvironment(
  host: Optional<() => Readonly<Record<string, string>>>,
  now = new Date()
): Readonly<Record<string, string>> {
  const offset = -now.getTimezoneOffset()
  const local = new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 19)
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0')
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(now)
  return {
    ...hostEntries(host),
    time: `${local}${offset < 0 ? '-' : '+'}${hours}:${minutes}`,
    localTime: `${local.replace('T', ' ')} ${weekday}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

/** 读宿主条目；失败或不是文本键值时记日志并返回空。 */
function hostEntries(
  host: Optional<() => Readonly<Record<string, string>>>
): Readonly<Record<string, string>> {
  if (!host) return {}
  try {
    const entries = host()
    if (isPlainObject(entries) && Object.values(entries).every(isString)) return entries
    Log.tag('ActRuntime').warn('宿主环境条目需要是文本键值，本帧只给时钟')
  } catch (error) {
    Log.tag('ActRuntime').warn('读取宿主环境条目失败，本帧只给时钟', error)
  }
  return {}
}
