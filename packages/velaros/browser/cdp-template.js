// velaros:cdp 的代码模版：直接发 CDP 命令的几种常见写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 命令跑在你自己的一条会话上：开关的域、设的仿真与拦截只算在这条会话上，reset 或 leave 时一并撤掉。都作用在 velaros:browser 当前打开的站点上，先 open。
import { events, reset, send, waitForEvent } from 'velaros:cdp'

// 复现手机上的深色布局：设设备尺寸、触摸与配色，之后回 velaros:browser 截图看；不要了就 reset。
async function mobileDark() {
  await send({ method: 'Emulation.setDeviceMetricsOverride', params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } })
  await send({ method: 'Emulation.setTouchEmulationEnabled', params: { enabled: true } })
  await send({ method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] } })
  return '手机尺寸与深色已设好'
}

// 读全部 cookie（含 HttpOnly 的），只交回名字与域。
async function cookieNames() {
  const { cookies } = await send({ method: 'Network.getCookies' })
  return cookies.map((cookie) => ({ name: cookie.name, domain: cookie.domain, httpOnly: cookie.httpOnly }))
}

// 看一个动作发了哪些请求：先开 Network 域、记下游标，再触发动作，最后读游标之后的请求。
async function requestsDuring(action = "document.querySelector('button.load-more')?.click()") {
  await send({ method: 'Network.enable' })
  const { last } = await events({})
  await send({ method: 'Runtime.evaluate', params: { expression: action, userGesture: true } })
  await waitForEvent({ method: 'Network.loadingFinished', after: last, timeoutMs: 10000 })
  const sent = await events({ method: 'Network.requestWillBeSent', after: last })
  return sent.events.map((event) => ({ method: event.params.request.method, url: event.params.request.url }))
}

// 拦下接口请求、改成假响应放行：先 Fetch.enable，等 requestPaused，fulfill 之后关掉拦截。
async function fakeResponse(urlPattern = '*/api/profile*') {
  await send({ method: 'Fetch.enable', params: { patterns: [{ urlPattern }] } })
  const { last } = await events({})
  await send({ method: 'Page.reload' })
  const paused = await waitForEvent({ method: 'Fetch.requestPaused', after: last, timeoutMs: 10000 })
  // 响应体要 base64；有中文时先按 UTF-8 编成字节再 btoa。
  const body = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ name: '测试用户' }))))
  await send({ method: 'Fetch.fulfillRequest', params: { requestId: paused.params.requestId, responseCode: 200, body } })
  await send({ method: 'Fetch.disable' })
  return paused.params.request.url
}

// 页面脚本跑之前先注入一段代码（只在这条会话开着时生效，reset 就没了）。
async function beforePageScripts(source = 'window.__velarosStarted = Date.now()') {
  const { identifier } = await send({ method: 'Page.addScriptToEvaluateOnNewDocument', params: { source } })
  await send({ method: 'Page.reload' })
  return identifier
}

// 撤掉自己做过的一切：仿真、拦截、注入、开过的域。
async function undoAll() {
  await reset()
  return '会话已断开，页面回到宿主的设置'
}
