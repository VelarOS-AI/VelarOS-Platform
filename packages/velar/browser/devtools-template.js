// velar:devtools 的代码模版：排障、调页面时最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 都作用在 velar:browser 当前打开的站点上，先 open。trace、堆快照、录屏的产物落在站点工作区。
// 页面存储用 velar:browser 的 evaluate 读；视口、深浅色、时区、cookie 这类直接用 velar:cdp 发命令。
import { createUserScript, diagnostics, insight, network, request, startRecording, startTrace, stopRecording } from 'velar:devtools'

// 页面报错了：看最近的控制台错误与未处理异常，读完把这一类清掉。
async function consoleErrors() {
  const errors = await diagnostics({ kind: 'console', errorsOnly: true, limit: 20, clear: true })
  return errors.entries.map((entry) => ({ level: entry.level, message: entry.message, url: entry.url }))
}

// 接口失败了：找失败的请求，读第一个的详情与响应体。
async function failedRequests() {
  const failed = await diagnostics({ kind: 'network', failedOnly: true, limit: 20 })
  const first = failed.entries[0]
  const requestId = first?.details?.requestId
  if (typeof requestId !== 'string') return { failures: failed.entries.length }
  const detail = await request({ requestId, includeResponseBody: true, maxBodyChars: 4000 })
  return { failures: failed.entries.length, first: { status: detail.response?.status, body: detail.responseBody?.body } }
}

// 页面加载慢：录一次完整加载，拿 Core Web Vitals，再深入看第一条 insight。
async function measureLoad() {
  const trace = await startTrace({ reload: true, autoStopMs: 5000 })
  if (trace.status !== 'completed') return { note: trace.note }
  const setId = trace.insightSetIds[0]
  const detail = setId ? await insight({ insightSetId: setId, insightName: 'LCPBreakdown' }) : null
  return { metrics: trace.keyMetrics, lcp: detail?.output.slice(0, 3000) }
}

// 给接口回假数据，看页面怎么降级：规则常驻，程序跑完也一直生效，再调一次 network 就换掉。
async function mockApi(urlPattern = '*/api/profile*') {
  await network({ mockResponses: [{ urlPattern, status: 500, contentType: 'application/json', body: '{"error":"boom"}' }] })
  return '之后匹配的请求都会拿到 500，刷新页面看效果；恢复就再调一次 network 清掉'
}

// 录下一段操作：开始录，做完操作再停，GIF 落在站点工作区。
async function record(name = 'checkout-flow') {
  await startRecording({ maxWidth: 800 })
  // ……这里用 velar:browser 做要录的操作……
  const gif = await stopRecording({ name })
  return { path: gif.relativePath, frames: gif.frameCount }
}

// 新建一个进站就自动跑的用户脚本：先停用存着，讲给用户听，用户同意后再 enableUserScript。
async function hidePopup() {
  const created = await createUserScript({
    name: '隐藏订阅弹窗',
    code: "document.querySelector('[data-newsletter-popup]')?.remove()",
    match: ['https://example.com/*'],
    runAt: 'document-end',
  })
  return { id: created.script?.id, enabled: created.script?.enabled }
}
