/**
 * 对话内「打开外部链接」的唯一出口 —— 协议白名单门（§5.3b ④ 安全门）。
 *
 * **挡什么**：富输出卡（web_search / web_read 等）展示的 URL 来自网络抓取与模型输出，是
 * **双重可控**的不可信数据。裸 `window.open(url)` 会把 `javascript:` / `data:` 交给浏览器，
 * 在把本包当普通 web 应用装载的宿主里，那是在 app origin 上执行任意脚本。
 *
 * **为什么门在这一层**：`HtmlPreviewFrame` 处理 iframe 上报的 open-link 时早已过
 * `normalizeHtmlArtifactExternalUrl`（http/https 白名单），但富输出卡的同类动作此前裸奔——
 * 同一个包里两套策略，是 §1.6「守卫单源」要治的形状。判定收在这里，调用点只问"开没开成"。
 *
 * **绕过后果 / 为什么不能依赖宿主兜底**：Desktop 宿主的 `setWindowOpenHandler` 确实会 deny
 * 并转 `shell.openExternal`，所以今天在 Desktop 上不成立为 renderer XSS。但本包是**宿主无关**的
 * 发布件（三宿主铁律：Desktop / Workbench / `velaros serve`），包的安全面不许建立在
 * 「某一个宿主恰好兜住了」之上——那正是「忘了接线」与「不受信」长得一样的形状（§2.3）。
 *
 * **失败方向**：非法或不可解析的 URL **不打开、返回 false**，由调用点决定是否提示；
 * 缺省是拒绝（§2.2 fail-closed），不是"拦不住就放行"。
 */
import { normalizeHtmlArtifactExternalUrl } from '@velaros-ai/html-artifacts/sandbox'

/**
 * 校验并打开外部链接。返回是否真的打开了（false = 被协议门拒绝或环境无 `window.open`）。
 */
export function openExternalUrl(value: unknown): boolean {
  const normalized = normalizeHtmlArtifactExternalUrl(value)
  if (!normalized) return false

  const opener = globalThis.window?.open
  if (!opener) return false

  opener.call(globalThis.window, normalized, '_blank', 'noopener,noreferrer')
  return true
}
