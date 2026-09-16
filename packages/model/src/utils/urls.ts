/**
 * provider 服务地址的收尾归一。
 *
 * 判据：本包所有请求 URL 都按 `${baseURL}/<路径>` 拼，baseURL 末尾留下任何一个 `/` 都会拼出 `//embeddings`
 * 这种打不通的地址。用户从浏览器地址栏粘出 `https://x//` 并不罕见，所以这里去掉**全部**末尾分隔符，
 * 而不是只去一个——与 platform 的 `trimTrailingPathTextSeparators` 同口径；model 不允许依赖 platform
 * （见 `scripts/model/check-arch-boundaries.mjs` 的依赖边界），所以在这里单独写一份。
 */
export function trimTrailingPathSeparators(value: string): string {
  const trimmed = value.trim()
  let end = trimmed.length
  while (end > 0 && trimmed[end - 1] === '/') end -= 1

  return trimmed.slice(0, end)
}
