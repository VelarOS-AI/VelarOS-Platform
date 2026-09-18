// 真机探针：用仓库里的 Electron 跑真实的浏览器运行时，按 ADR 0012 的承诺把三件能力的操作各走一遍，
// 内嵌页面（Electron webContents）与外部浏览器（产品自带的启动器拉起系统 Chrome，临时配置目录、无头）两条路径各跑一轮。bun test 不跑它。
// 跑法（先在 packages/velar 下 bun run build）：
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron packages/velar/browser/test/probes/electron-low-level.probe.mjs
// 每一项打一行 ✓ 或 ✗，全过退出码 0；没装 Chrome 时外部那一轮跳过。
import { existsSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { createElectronBrowserRuntime } from '../../../dist/browser/electron.js'
import { browserOperations, cdpOperations, devtoolsOperations } from '../../../dist/browser/index.js'

const ChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failureOf = async (run) => {
  try {
    await run()
    return { code: 'NONE', message: '' }
  } catch (error) {
    return { code: error.code ?? 'UNKNOWN', message: error.message }
  }
}

/** 一页假站点：React 式受控输入、可编辑区、回车提交的搜索框、鼠标画板、双击按钮，三层框架（同源子框架、跨源 iframe、跨源 iframe 里再套回主站的）。 */
function pageHtml(framePort) {
  return `<!doctype html><html><head><title>探针页</title></head><body>
<form id="search"><input id="q" name="q"></form>
<input id="email"><div id="editor" contenteditable="true">旧内容</div><input id="shift">
<div id="pad" style="position:absolute;left:50px;top:300px;width:300px;height:100px;background:#eee"></div>
<button id="dbl" style="position:absolute;left:420px;top:320px">双击</button>
<iframe id="pay" src="http://127.0.0.1:${framePort}/frame" style="position:absolute;left:0;top:450px;width:300px;height:120px"></iframe>
<iframe id="inner" src="/inner" style="position:absolute;left:320px;top:450px;width:200px;height:80px"></iframe>
<script>
  window.__submits = 0
  document.getElementById('search').addEventListener('submit', (event) => { event.preventDefault(); window.__submits += 1 })
  // 像 React 那样记着「上次写进去的值」：脚本直接赋 value 不算改动，只有真的输入才算。
  const email = document.getElementById('email')
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  let tracked = ''
  Object.defineProperty(email, 'value', { configurable: true, get() { return native.get.call(this) }, set(value) { tracked = String(value); native.set.call(this, value) } })
  window.__changes = []
  email.addEventListener('input', () => { const next = native.get.call(email); if (next !== tracked) { tracked = next; window.__changes.push(next) } })
  window.__pad = []
  const pad = document.getElementById('pad')
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'wheel']) pad.addEventListener(type, (event) => window.__pad.push({ type, buttons: event.buttons, trusted: event.isTrusted }))
  window.__dbl = 0
  document.getElementById('dbl').addEventListener('dblclick', (event) => { if (event.isTrusted) window.__dbl += 1 })
</script></body></html>`
}

/** 框架页：在自己的主世界里放一个全局变量，evaluate 读得到它就说明跑在框架的主世界里（不是隔离世界）。 */
const framePage = (body, flag, value) => `<html><body>${body}<script>window.${flag} = ${JSON.stringify(value)}</script></body></html>`

/** 起两个本地站点：主站（localhost）与跨源 iframe 所在的另一个站点（127.0.0.1）。 */
async function startServers() {
  let mainPort = 0
  const frame = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(framePage(`跨源框架里的正文<iframe src="http://localhost:${mainPort}/nested"></iframe>`, '__frameFlag', 'oopif'))
  })
  await new Promise((resolve) => frame.listen(0, '127.0.0.1', resolve))
  const framePort = frame.address().port
  const main = http.createServer((request, response) => {
    if (request.url.startsWith('/api')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ path: request.url }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (request.url.startsWith('/inner')) response.end(framePage('同源子框架', '__innerFlag', 42))
    else if (request.url.startsWith('/nested')) response.end(framePage('跨源里再套的', '__nestedFlag', 'nested'))
    else if (request.url.startsWith('/page2')) response.end('<html><head><title>第二页</title></head><body>第二页</body></html>')
    else response.end(pageHtml(framePort))
  })
  await new Promise((resolve) => main.listen(0, 'localhost', resolve))
  mainPort = main.address().port
  return { url: `http://localhost:${main.address().port}/`, close: () => [main, frame].forEach((server) => server.close()) }
}

/** 按运行时拼一个空间端口：宿主拼端口的写法，只接这次探针用到的方法。 */
function createPort(runtime, sessionId, context) {
  const bind = (method) => (options) => runtime[method](sessionId, context, options)
  return {
    isActive: () => true,
    getContext: () => context,
    ...Object.fromEntries(['getPageState', 'listPageTargets', 'listPendingEvents', 'resetProtocolSession', 'listFrames', 'evaluateScript', 'performTargetAction',
      'insertText', 'pressKey', 'keyDown', 'keyUp', 'moveMouse', 'mouseDown', 'mouseUp', 'mouseWheel', 'clickCoordinates', 'getPageDiagnostics',
      'sendProtocolCommand', 'readProtocolEvents', 'waitForPage'].map((method) => [method, bind(method)])),
  }
}

/** 一轮检查：label 标在每一行前面。 */
async function suite(label, ctx) {
  const check = (name, ok, detail = '') => {
    results.push(ok)
    console.info(`${ok ? '✓' : '✗'} [${label}] ${name}${detail ? `：${detail}` : ''}`)
  }
  const evaluate = (script, extra = {}) => browserOperations.evaluate({ script, ...extra }, ctx)

  // evaluate：整份取回、args、报错带 script 里的行列
  const rows = await evaluate('(count) => Array.from({ length: count }, (_, index) => ({ index }))', { args: [12000] })
  check('evaluate 整份取回一万二千项', rows.length === 12000 && rows.at(-1).index === 11999, `拿到 ${rows.length} 项`)
  const thrown = await failureOf(() => evaluate('() => {\n  const node = null\n  return node.value\n}'))
  check('页面脚本抛错带 script 里的行列', thrown.code === 'BROWSER_SCRIPT_FAILED' && thrown.message.includes('第 3 行'), thrown.message)

  // 框架：三层都列得出，evaluate 在每一层都跑在框架自己的主世界里（读得到页面放的全局变量），框架里抛错也换算回 script 的行号
  const frames = await browserOperations.frames(ctx)
  const byPath = (path) => frames.find((frame) => new URL(frame.url).pathname === path)
  const [pay, inner, nested] = ['/frame', '/inner', '/nested'].map(byPath)
  const tree = frames.map((frame) => ({ url: new URL(frame.url).pathname, crossOrigin: frame.crossOrigin, parent: frames.find((parent) => parent.id === frame.parentId)?.url ?? null }))
  check('frames 列出各层框架', !!pay?.crossOrigin && !!inner && !inner.crossOrigin && !!nested && nested.parentId === pay?.id, JSON.stringify(tree))
  const readFlag = (frame, name) => (frame ? evaluate(`window.${name}`, { frame: frame.id }).catch((error) => error.message) : null)
  check('evaluate 进得了跨源 iframe 的主世界', (await readFlag(pay, '__frameFlag')) === 'oopif')
  check('evaluate 进得了同源子框架的主世界', (await readFlag(inner, '__innerFlag')) === 42)
  check('evaluate 进得了跨源 iframe 里再套的框架', (await readFlag(nested, '__nestedFlag')) === 'nested')
  const frameThrown = inner ? await failureOf(() => evaluate('() => {\n  return null.value\n}', { frame: inner.id })) : null
  check('子框架里抛错也带 script 里的行号', frameThrown?.code === 'BROWSER_SCRIPT_FAILED' && frameThrown.message.includes('第 2 行'), frameThrown?.message)
  const { last: attachFrom } = await cdpOperations.events({}, ctx)
  await cdpOperations.send({ method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false } }, ctx)
  await cdpOperations.waitForEvent({ method: 'Target.attachedToTarget', after: attachFrom, timeoutMs: 5000 }, ctx)
  const attached = (await cdpOperations.events({ method: 'Target.attachedToTarget', after: attachFrom }, ctx)).events
    .find((event) => String(event.params.targetInfo?.url).includes('/frame'))
  const viaCdp = attached
    ? await cdpOperations.send({ method: 'Runtime.evaluate', params: { expression: 'window.__frameFlag', returnByValue: true }, session: attached.params.sessionId }, ctx)
    : null
  check('模型经 CDP 子会话进跨源 iframe', viaCdp?.result?.value === 'oopif', JSON.stringify(viaCdp?.result ?? null))
  await cdpOperations.reset(ctx)

  // fill：React 式受控输入认得到、可编辑区替换、空字符串清空
  const filled = await browserOperations.fill({ target: '#email', value: 'user@example.com' }, ctx)
  const changes = await evaluate('window.__changes')
  check('fill 让受控输入触发改动', filled.matched && changes.includes('user@example.com') && filled.controlState?.value === 'user@example.com', JSON.stringify({ changes, state: filled.controlState }))
  await browserOperations.fill({ target: '#editor', value: '新内容' }, ctx)
  check('fill 替换可编辑区的内容', (await evaluate("document.getElementById('editor').innerText")) === '新内容')
  await browserOperations.fill({ target: '#email', value: '' }, ctx)
  check('fill 空字符串清空', (await evaluate("document.getElementById('email').value")) === '')

  // 键盘：回车提交表单，按住 Shift 输入大写
  await browserOperations.fill({ target: '#q', value: 'velaros' }, ctx)
  await browserOperations.press({ key: 'Enter' }, ctx)
  check('press Enter 提交表单', (await evaluate('window.__submits')) === 1)
  await browserOperations.click({ target: '#shift' }, ctx)
  await browserOperations.keyDown({ key: 'Shift' }, ctx)
  await browserOperations.press({ key: 'a' }, ctx)
  const released = await browserOperations.keyUp({ key: 'Shift' }, ctx)
  check('按住 Shift 输入是大写', (await evaluate("document.getElementById('shift').value")) === 'A' && released.held.length === 0)

  // 鼠标原子：按下、带着按键移动、松开，事件是真的；滚轮落在指针下；双击
  await browserOperations.mouseMove({ x: 150, y: 350 }, ctx)
  await browserOperations.mouseDown({}, ctx)
  await browserOperations.mouseMove({ x: 250, y: 350, steps: 4 }, ctx)
  const up = await browserOperations.mouseUp({}, ctx)
  await browserOperations.wheel({ deltaY: 120 }, ctx)
  const pad = await evaluate('window.__pad')
  const dragged = pad.some((event) => event.type === 'mousemove' && event.buttons === 1 && event.trusted)
  check('鼠标原子拖出的是真事件', dragged && pad.some((event) => event.type === 'mouseup') && up.x === 250 && up.buttons.length === 0, JSON.stringify(pad.slice(0, 4)))
  check('滚轮落在指针下的元素上', pad.some((event) => event.type === 'wheel' && event.trusted))
  await browserOperations.click({ target: '#dbl', clickCount: 2 }, ctx)
  check('clickCount 2 是一次真的双击', (await evaluate('window.__dbl')) === 1)

  // 模型的 CDP 会话：宿主诊断照常、同一个请求不记两遍
  await devtoolsOperations.diagnostics({ kind: 'network' }, ctx)
  await cdpOperations.send({ method: 'Network.enable' }, ctx)
  const { last } = await cdpOperations.events({}, ctx)
  await evaluate("fetch('/api?probe=once').then((response) => response.text())")
  await cdpOperations.waitForEvent({ method: 'Network.loadingFinished', after: last, timeoutMs: 5000 }, ctx)
  const seen = await cdpOperations.events({ method: 'Network.requestWillBeSent', after: last }, ctx)
  check('模型会话收到自己的网络事件', seen.events.some((event) => String(event.params.request.url).includes('probe=once')))
  await sleep(300)
  const host = await devtoolsOperations.diagnostics({ kind: 'network' }, ctx)
  const recorded = host.entries.filter((entry) => String(entry.url).includes('probe=once'))
  check('宿主诊断里同一个请求只记一次', recorded.length === 1, `记了 ${recorded.length} 次`)
  await cdpOperations.send({ method: 'Network.disable' }, ctx)
  await evaluate("fetch('/api?probe=after-disable').then((response) => response.text())")
  await sleep(300)
  const afterDisable = await devtoolsOperations.diagnostics({ kind: 'network' }, ctx)
  check('模型关掉 Network 域，宿主诊断照常', afterDisable.entries.some((entry) => String(entry.url).includes('probe=after-disable')))

  // 仿真跟着模型的会话走，reset 就撤掉
  await cdpOperations.send({ method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] } }, ctx)
  const darkWhile = await evaluate("matchMedia('(prefers-color-scheme: dark)').matches")
  await cdpOperations.reset(ctx)
  const darkAfter = await evaluate("matchMedia('(prefers-color-scheme: dark)').matches")
  check('reset 撤掉模型设的仿真', darkWhile === true && darkAfter === false, `设了之后 ${darkWhile}，reset 之后 ${darkAfter}`)

  // 被拦下没人放行的请求：到点由宿主放行，并记一条事件（把时钟往前拨 31 秒，等兜底扫一轮）
  await cdpOperations.send({ method: 'Fetch.enable', params: { patterns: [{ urlPattern: '*api-hold*' }] } }, ctx)
  const before = (await cdpOperations.events({}, ctx)).last
  await evaluate("() => { window.__held = null; fetch('/api-hold').then((response) => response.text()).then((text) => { window.__held = text }); return 1 }")
  const paused = await cdpOperations.waitForEvent({ method: 'Fetch.requestPaused', after: before, timeoutMs: 5000 }, ctx)
  const realNow = Date.now
  Date.now = () => realNow() + 31_000
  await sleep(1_500)
  Date.now = realNow
  await sleep(300)
  const held = await evaluate('window.__held')
  const note = await cdpOperations.events({ method: 'Velar.requestAutoContinued', after: before }, ctx)
  check('没人放行的请求到点被宿主放行', !!paused && JSON.parse(held ?? '{}').path === '/api-hold' && note.events.length === 1, JSON.stringify({ held, notes: note.events.length }))
  await cdpOperations.reset(ctx)

  // 等待撑得过真跳转
  await evaluate("() => { setTimeout(() => { location.href = '/page2' }, 300); return 1 }")
  const arrived = await browserOperations.waitForFunction({ script: "location.pathname === '/page2' && document.readyState === 'complete'", timeoutMs: 10000 }, ctx)
  check('waitForFunction 跨过真跳转', arrived === true)
}

async function run() {
  const servers = await startServers()
  const runtime = createElectronBrowserRuntime()
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'velaros-probe-'))
  const contextOf = () => ({ url: servers.url, workspaceRoot })
  const ctxOf = (sessionId, context) => ({ abortSignal: new AbortController().signal, browser: createPort(runtime, sessionId, context) })

  const window = new BrowserWindow({ show: false, width: 1000, height: 700 })
  await window.loadURL(servers.url)
  const embedded = contextOf()
  await runtime.presentPage('embedded', embedded, window.webContents.id)
  try {
    await suite('内嵌', ctxOf('embedded', embedded))
  } finally {
    await runtime.closeSession('embedded')
    window.destroy()
  }

  if (existsSync(ChromePath)) {
    const external = contextOf()
    await runtime.launchExternalBrowserPage('external', external, { executablePath: ChromePath, args: ['--headless=new', '--window-size=1000,700'] })
    try {
      await suite('外部 Chrome', ctxOf('external', external))
    } finally {
      await runtime.closeSession('external')
    }
  } else {
    console.info(`- 没找到 ${ChromePath}，外部浏览器那一轮跳过`)
  }
  servers.close()
}

// 内嵌那一轮关掉唯一的窗口时 Electron 默认就退出了：探针自己决定什么时候退。
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    await run()
  } catch (error) {
    results.push(false)
    console.info(`✗ 探针没跑完：${error.stack}`)
  }
  const passed = results.filter(Boolean).length
  console.info(`\n${passed}/${results.length} 通过`)
  app.exit(passed === results.length ? 0 : 1)
})
