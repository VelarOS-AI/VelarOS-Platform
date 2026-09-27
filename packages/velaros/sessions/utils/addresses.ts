/** 开新会话时的两个地方：项目目录（绝对路径，不管宿主跑在哪个平台）与浏览器先打开的网址（只认 http 与 https）。 */

/**
 * 是不是绝对路径，照宿主可能跑的每个平台都认：/ 开头的（macOS、Linux）、盘符加斜杠开头的（C:\ 或 C:/）、
 * \\服务器\共享 这样的网络路径。~ 开头的、相对路径、只写了盘符的（C:work）、只有一个反斜杠开头的（\work，不知道在哪个盘）都不算。
 */
export function isAbsolutePath(path: string): boolean {
  return (
    /^\//u.test(path) || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(path)
  )
}

/** 网址的规范写法：是 http 或 https 的网址就交回 URL 规范过的写法，别的协议、解析不了的交回 null。 */
export function webAddress(value: string): Nullable<string> {
  if (!URL.canParse(value)) return null
  const url = new URL(value)
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}
