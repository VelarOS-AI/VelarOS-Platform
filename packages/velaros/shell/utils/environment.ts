import { AppError } from '@velaros-ai/core/error'

/** 只解析随机标记之后的 NUL 分隔环境，登录启动脚本的欢迎输出不属于环境。 */
export function parseLoginEnvironment(source: string, marker: string): NodeJS.ProcessEnv {
  const boundary = `\0${marker}\0`
  const offset = source.indexOf(boundary)
  if (offset < 0 || !source.endsWith('\0'))
    throw new AppError('PLATFORM', '登录 shell 返回的环境不完整。')
  const entries = source.slice(offset + boundary.length).split('\0')
  return Object.fromEntries(entries.filter((entry) => entry.indexOf('=') > 0).map((entry) => {
    const separator = entry.indexOf('=')
    return [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
}
