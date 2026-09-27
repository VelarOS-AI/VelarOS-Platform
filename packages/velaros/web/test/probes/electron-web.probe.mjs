// 真机探针：用仓库里的 Electron 当宿主，照 WebSpacePort 接一个不显示的窗口（show:false、不带 persist: 的临时分区、关掉后台节流），
// 把 velaros:web 在真浏览器里走一遍：先在本地夹具页上核对页面脚本（Bing、Google 结果页，带导航页眉页脚的文章、整页包在 form 里的老站、
// 弹窗时正文被标成 aria-hidden 的页面、页面自己跳走、分两步渲染的单页应用），再真搜一次中文、一次英文（用户选 Google：打不开就换 Bing），
// 读第一条结果，并打印用了哪个搜索引擎、几条结果、前几条标题；最后在一个发往 Google 的请求一律卡住的临时会话里真走一遍换 Bing，
// 量从开始搜到开始装 Bing 结果页用了多久，并把 12 小时的退避写进一个临时 JSON 文件，再用一份新起的操作（像重启之后）核对它照这份文件跳过 Google。bun test 不跑它。
// 跑法（先在 packages/velaros 下 bun run build）：
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron packages/velaros/web/test/probes/electron-web.probe.mjs
// 不碰用户自己的 Chrome：页面都是 Electron 自己的隐藏窗口，会话只在内存里，跑完就没了。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { app, BrowserWindow, net, session } from 'electron'

import { WebOperations } from '../../../dist/web/impl/WebOperations.js'
import { webOperations } from '../../../dist/web/index.js'
import {
  BingResultsScript,
  GoogleResultsScript,
  ReadableTextScript,
} from '../../../dist/web/utils/page-scripts.js'

/** 不带 persist: 的分区只在内存里：碰不到用户的登录与记录，退出就没了。 */
const Partition = `velaros-web-probe-${process.pid}`
/** 另一个临时分区：发往 Google 的请求一律卡住不回，像国内那样打不开 Google，用来真走一遍换 Bing。 */
const GoogleDownPartition = `velaros-web-probe-google-down-${process.pid}`

const results = []
const check = (name, passed, detail = '') => {
  results.push(passed)
  console.info(`${passed ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
}
const info = (line) => console.info(`  ${line}`)

// ── 宿主端口：照 README 的写法接 ─────────────────────────────────

/** 等页面停止加载（页面自己跳走之后，新的那一页还在加载）。 */
function waitForStop(contents, signal) {
  return new Promise((resolve, reject) => {
    if (!contents.isLoading()) return resolve()
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    contents.once('did-stop-loading', () => {
      signal.removeEventListener('abort', abort)
      resolve()
    })
  })
}

/** 装地址：signal 触发就停；页面自己跳走时 loadURL 以 ERR_ABORTED 失败，其实新的一页还在加载，等它停下来。 */
async function loadPage(contents, url, signal) {
  signal.throwIfAborted()
  const stop = () => {
    if (!contents.isDestroyed()) contents.stop()
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    await contents.loadURL(url)
  } catch (error) {
    if (error.code !== 'ERR_ABORTED' || signal.aborted) throw error
    await waitForStop(contents, signal)
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** 跟一跳服务端跳转、不加载目标：同一个临时会话里发请求，读 302 的 Location；不是跳转交回 null。 */
function resolveRedirect(partition, url, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const request = net.request({
      url,
      redirect: 'manual',
      session: session.fromPartition(partition),
      useSessionCookies: true,
    })
    const abort = () => {
      request.abort()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    const settle = (value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }
    request.on('redirect', (_status, _method, location) => {
      settle(location)
      request.abort()
    })
    request.on('response', (response) => {
      settle(null)
      response.on('data', () => {})
    })
    request.on('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    request.end()
  })
}

/**
 * 退避记忆的宿主写法：启动时把 JSON 文件读进内存，read 从内存交回，write 改内存再落盘。
 * 文件坏了、不在就当什么都没记着。
 */
function createBackoffFile(path) {
  let saved = {}
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    saved = {}
  }
  return {
    read: (engine) => (Number.isFinite(saved[engine]) ? saved[engine] : null),
    write: (engine, until) => {
      saved = { ...saved, [engine]: until }
      writeFileSync(path, JSON.stringify(saved))
    },
  }
}

/** 一份宿主端口：用户选的搜索引擎，开出来的页面都是隐藏窗口；记着开着的窗口与每次装地址的时刻，好核对都关掉了、量换 Bing 用了多久。 */
function createPort(engine, partition = Partition, backoff = null) {
  const open = new Set()
  const loads = []
  const port = {
    searchEngine: () => engine,
    resolveRedirect: (url, signal) => resolveRedirect(partition, url, signal),
    openPage: async (signal) => {
      signal.throwIfAborted()
      const window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: { partition, backgroundThrottling: false, sandbox: true },
      })
      const contents = window.webContents
      contents.setAudioMuted(true)
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      open.add(window)
      return {
        load: (url, loadSignal) => {
          loads.push({ url, at: Date.now() })
          return loadPage(contents, url, loadSignal)
        },
        // mainFrame 上的当场跑；webContents.executeJavaScript 要等页面停止加载才跑，结果页就得等整页加载完
        evaluate: (expression) => contents.mainFrame.executeJavaScript(expression),
        url: () => (contents.isDestroyed() ? '' : contents.getURL()),
        loading: () => !contents.isDestroyed() && contents.isLoadingMainFrame(),
        close: () => {
          open.delete(window)
          if (!window.isDestroyed()) window.destroy()
        },
      }
    },
  }
  if (backoff) port.engineBackoff = backoff
  return { port, loads, openWindows: () => open.size }
}

const contextOf = (port) => ({ abortSignal: new AbortController().signal, web: port })

// ── 本地夹具页 ──────────────────────────────────────────────────

const bingRedirect = (target) =>
  `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(target).toString('base64url')}&ntb=1`

const Fixtures = {
  '/bing': `<!doctype html><html><head><title>Bing</title></head><body><ol id="b_results">
<li class="b_algo"><h2><a href="${bingRedirect('https://example.com/one')}">Example <strong>One</strong></a></h2>
<div class="b_caption"><p class="b_lineclamp2 b_algoSlug"><span class="algoSlug_icon" data-priority="2">网页</span>First   snippet
text</p></div></li>
<li class="b_algo"><h2><a href="https://example.org/two">第二条</a></h2><p>第二条的摘要</p></li>
<li class="b_ad"><h2><a href="https://ads.example/">广告</a></h2></li>
</ol></body></html>`,
  '/bing-empty': `<!doctype html><html><body><ol id="b_results"><li class="b_no"><h1>There are no results for qzxv</h1></li></ol></body></html>`,
  '/google': `<!doctype html><html><head><title>Google</title></head><body><div id="search"><div id="rso">
<div class="MjjYud"><div class="g"><div class="yuRUbf"><div><span><a href="https://example.com/g1"><br><h3 class="LC20lb">Google One</h3><div><cite>example.com</cite></div></a></span></div></div>
<div class="VwiC3b">Google   snippet one</div></div></div>
<div class="MjjYud"><div class="g"><a href="/url?q=https://example.com/g2&amp;sa=U"><h3>Google Two</h3></a><div data-sncf="1">Snippet two</div></div></div>
<div class="MjjYud"><div class="g"><a href="https://example.com/g1#again"><h3>Same page again</h3></a></div></div>
</div></div></body></html>`,
  '/article': `<!doctype html><html><head><title>文章页</title></head><body>
<header><nav>首页 | 关于 | 很长的导航链接</nav></header>
<aside>侧栏推荐</aside>
<main><article><h1>文章标题</h1><p>第一段正文。</p><p>第二段正文，<b>有加粗</b>。</p><ul><li>列表一</li><li>列表二</li></ul></article>
<div class="comments">评论区的一句话</div></main>
<form><input placeholder="站内搜索"><button>搜索按钮</button></form>
<footer>版权所有</footer>
<script>var hidden = '脚本里的字'</script><style>.x { color: red }</style>
<div hidden>藏起来的字</div>
</body></html>`,
  '/wrapped': `<!doctype html><html><head><title>老站</title></head><body><form id="aspnetForm">
<div id="content"><h1>表单包着的正文</h1><p>${'这是老站点的正文，整页都包在一个 form 里。'.repeat(8)}</p></div>
<div class="links"><a href="/a">链接</a></div></form></body></html>`,
  '/modal': `<!doctype html><html><head><title>弹窗</title></head><body>
<div id="app" aria-hidden="true"><h1>弹窗后面的正文</h1><p>${'弹窗打开时正文被标成 aria-hidden。'.repeat(8)}</p></div>
<div role="dialog">接受 Cookie？</div></body></html>`,
  '/jump': `<!doctype html><html><head><title>跳转中</title><script>location.replace('/article')</script></head><body>跳转中……</body></html>`,
  '/late-jump': `<!doctype html><html><head><title>稍等</title><script>addEventListener('load', () => location.replace('/slow-article'))</script></head><body>正在跳到正文……</body></html>`,
  '/spa': `<!doctype html><html><head><title>单页应用</title></head><body><div id="root">加载中</div><script>
setTimeout(() => { document.getElementById('root').innerHTML = '<p>骨架……</p>' }, 300)
setTimeout(() => { document.getElementById('root').innerHTML = '<article><h1>单页应用</h1><p>${'异步渲染出来的正文。'.repeat(10)}</p></article>' }, 700)
</script></body></html>`,
}

/** 慢吞吞的正文页：过一秒半才回，加载完之后自己跳过来的页面要等它。 */
const SlowArticle = `<!doctype html><html><head><title>慢正文</title></head><body><article><h1>慢正文</h1><p>${'一秒半之后才到的正文。'.repeat(6)}</p></article></body></html>`

/** 起一个本地站点，按路径交夹具页；/slow-article 过一秒半才回。 */
async function startFixtures() {
  const server = http.createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === '/slow-article') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(SlowArticle)
      }, 1_500)
      return
    }
    const page = Fixtures[path]
    response.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page ?? 'not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

/** 在一个隐藏窗口里打开夹具页，跑一段页面脚本。 */
async function runScript(port, url, script) {
  const page = await port.openPage(new AbortController().signal)
  try {
    await page.load(url, new AbortController().signal)
    return await page.evaluate(script)
  } finally {
    page.close()
  }
}

async function fixtureSuite(port, origin) {
  const bing = await runScript(port, `${origin}/bing`, BingResultsScript)
  check(
    'Bing 结果页：认出两条自然结果（广告不算），标题并好空白，摘要去掉「网页」小标签',
    bing.hits.length === 2 &&
      bing.hits[0].title === 'Example One' &&
      bing.hits[0].snippet === 'First snippet text' &&
      bing.hits[0].href.startsWith('https://www.bing.com/ck/a') &&
      bing.hits[1].snippet === '第二条的摘要' &&
      !bing.noResults,
    JSON.stringify(bing.hits)
  )
  const empty = await runScript(port, `${origin}/bing-empty`, BingResultsScript)
  check('Bing 明说没有结果：认出 .b_no', empty.hits.length === 0 && empty.noResults === true)

  const google = await runScript(port, `${origin}/google`, GoogleResultsScript)
  check(
    'Google 结果页：包着 h3 的链接一条一个，摘要取同一条结果块里的，/url 链接交回绝对地址',
    google.hits.length === 3 &&
      google.hits[0].title === 'Google One' &&
      google.hits[0].snippet === 'Google snippet one' &&
      google.hits[1].href === `${origin}/url?q=https://example.com/g2&sa=U` &&
      google.hits[1].snippet === 'Snippet two',
    JSON.stringify(google.hits)
  )

  const article = await runScript(port, `${origin}/article`, ReadableTextScript)
  const text = article.text
  check(
    '文章页：只读 main，p 之间空一行、列表逐行；导航、侧栏、表单、页脚、脚本、hidden 都删掉',
    text.includes('文章标题') &&
      text.includes('第一段正文。\n\n第二段正文，有加粗。') &&
      text.includes('列表一\n列表二') &&
      text.includes('评论区的一句话') &&
      !/导航|侧栏|站内搜索|搜索按钮|版权|脚本里的字|藏起来的字/u.test(text) &&
      article.title === '文章页' &&
      article.contentType === 'text/html',
    JSON.stringify(text)
  )
  const wrapped = await runScript(port, `${origin}/wrapped`, ReadableTextScript)
  check(
    '整页包在 form 里的老站：包着大半正文的 form 不删',
    wrapped.text.includes('表单包着的正文'),
    JSON.stringify(wrapped.text.slice(0, 60))
  )
  const modal = await runScript(port, `${origin}/modal`, ReadableTextScript)
  check(
    '弹窗时正文被标 aria-hidden：包着大半正文的不删',
    modal.text.includes('弹窗后面的正文'),
    JSON.stringify(modal.text.slice(0, 60))
  )

  const ctx = contextOf(port)
  const jumped = await webOperations.read({ url: `${origin}/jump` }, ctx)
  check(
    'read 页面自己跳走：读到跳过去的那一页，url 是最终地址',
    jumped.url === `${origin}/article` && jumped.text.includes('第一段正文'),
    `${jumped.url} ${JSON.stringify(jumped.text.slice(0, 40))}`
  )
  const started = Date.now()
  const spa = await webOperations.read({ url: `${origin}/spa` }, ctx)
  check(
    'read 分两步渲染的单页应用：等渲染稳了再读，读到最终的正文',
    spa.text.includes('异步渲染出来的正文') && !spa.text.includes('骨架'),
    `${Date.now() - started} ms，${JSON.stringify(spa.text.slice(0, 40))}`
  )
  const late = await webOperations.read({ url: `${origin}/late-jump` }, ctx)
  check(
    'read 加载完之后页面自己又跳到一个慢页面：等它跳完再读',
    late.url === `${origin}/slow-article` && late.text.includes('一秒半之后才到的正文'),
    `${late.url} ${JSON.stringify(late.text.slice(0, 30))}`
  )
  const sliced = await webOperations.read({ url: `${origin}/article`, maxChars: 10 }, ctx)
  check(
    'read 按字符切段：10 个字符一段，nextOffset 接得上',
    sliced.text.length === 10 && sliced.nextOffset === 10 && sliced.totalChars > 10,
    JSON.stringify(sliced)
  )
  try {
    await webOperations.read({ url: 'http://127.0.0.1:9/nothing' }, ctx)
    check('read 连不上的地址抛 WEB_PAGE_UNREACHABLE', false, '竟然读成了')
  } catch (error) {
    check(
      'read 连不上的地址抛 WEB_PAGE_UNREACHABLE',
      error.code === 'WEB_PAGE_UNREACHABLE',
      `${error.code}：${error.message}`
    )
  }
}

// ── 真搜索 ──────────────────────────────────────────────────────

/** 新起一份操作（真钟）：进程里的记忆是空的，像刚启动。 */
function freshOperations() {
  return new WebOperations({
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeout: (ms) => AbortSignal.timeout(ms),
  })
}

/** 真搜一次：打印用了哪个搜索引擎、几条、前三条标题与耗时。 */
async function liveSearch(port, query, operations = webOperations) {
  const started = Date.now()
  try {
    const found = await operations.search({ query, limit: 8 }, contextOf(port))
    const ms = Date.now() - started
    check(
      `真搜「${query}」有结果`,
      found.results.length > 0,
      `${found.engine}，${found.results.length} 条，${ms} ms`
    )
    for (const result of found.results.slice(0, 3)) info(`${result.title} — ${result.url}`)
    if (found.results[0]) info(`摘要：${found.results[0].snippet.slice(0, 80)}`)
    return found
  } catch (error) {
    check(
      `真搜「${query}」有结果`,
      false,
      `${error.code}：${error.message}（${Date.now() - started} ms）`
    )
    return null
  }
}

async function liveSuite() {
  const google = createPort('google')
  const chinese = await liveSearch(google.port, '上海 天气 预报')
  const english = await liveSearch(google.port, 'TypeScript satisfies operator')
  if (chinese?.engine === 'bing')
    info(
      'Google 搜不通，换成了 Bing；接下来 12 小时的搜索直接走 Bing（上面第二次搜索的耗时就是这样来的）'
    )
  const gotos = [chinese, english]
    .flatMap((found) => found?.results ?? [])
    .filter((result) => result.url.includes('google.com/goto'))
  check('Google 的 /goto 跳转链接都换成了真实地址', gotos.length === 0, `${gotos.length} 条没换`)
  const target = english?.results[0] ?? chinese?.results[0]
  if (target) {
    const started = Date.now()
    try {
      const page = await webOperations.read(
        { url: target.url, maxChars: 2000 },
        contextOf(google.port)
      )
      check(
        '真读第一条结果',
        page.text.length > 0,
        `${page.title}，全文 ${page.totalChars} 个字符，${Date.now() - started} ms`
      )
      info(`落在：${page.url}`)
      info(`开头：${JSON.stringify(page.text.slice(0, 200))}`)
    } catch (error) {
      check('真读第一条结果', false, `${error.code}：${error.message}`)
    }
  }
  const bing = createPort('bing')
  await liveSearch(bing.port, 'Electron BrowserWindow show false')
  check(
    '真搜真读之后隐藏窗口都关掉了',
    google.openWindows() === 0 && bing.openWindows() === 0,
    `${google.openWindows() + bing.openWindows()} 个没关`
  )
}

/**
 * 打不开 Google 的网络：发往 Google 的请求卡住不回。第一次搜到 Google 的落下时限就换 Bing（量从开始搜到开始装 Bing 结果页用了多久），
 * 退避写进一个临时 JSON 文件；之后的搜索一个 Google 请求都不发；再用一份新起的操作（像重启之后，进程里什么都没记着）照这份文件跳过 Google。
 */
async function googleDownSuite() {
  const down = session.fromPartition(GoogleDownPartition)
  down.setUserAgent(down.getUserAgent().replace(/\s(?:Electron|electron-web-probe)\/\S+/gu, ''))
  let googleRequests = 0
  down.webRequest.onBeforeRequest({ urls: ['*://*.google.com/*', '*://google.com/*'] }, () => {
    googleRequests += 1 // 不回：像被墙时那样一直等
  })
  const directory = mkdtempSync(join(tmpdir(), 'velaros-web-probe-'))
  const backoffPath = join(directory, 'engine-backoff.json')
  // 新起一份操作：前面真搜时 Google 若已经搜不通，进程里那份记着退避，这里要从头量一次换 Bing
  const operations = freshOperations()
  try {
    const blocked = createPort('google', GoogleDownPartition, createBackoffFile(backoffPath))
    const started = Date.now()
    const first = await liveSearch(blocked.port, '北京 故宫 开放时间', operations)
    const bingLoad = blocked.loads.find((load) => load.url.startsWith('https://www.bing.com/'))
    const fallbackMs = bingLoad ? bingLoad.at - started : Number.POSITIVE_INFINITY
    check(
      '打不开 Google：6 秒以内开始装 Bing 的结果页',
      first?.engine === 'bing' && fallbackMs <= 6_000,
      `${first?.engine}，从开始搜到开始装 Bing 用了 ${fallbackMs} ms`
    )
    const saved = JSON.parse(readFileSync(backoffPath, 'utf8'))
    const hours = (saved.google - Date.now()) / 3_600_000
    check(
      '退避写进了宿主的 JSON 文件：12 小时',
      hours > 11.9 && hours <= 12,
      `${JSON.stringify(saved)}（约 ${hours.toFixed(2)} 小时后到期）`
    )
    const before = googleRequests
    const again = Date.now()
    const second = await liveSearch(blocked.port, 'Rust ownership explained', operations)
    check(
      '记住 Google 打不开：接下来的搜索直接走 Bing，一个 Google 请求都不发',
      second?.engine === 'bing' && googleRequests === before,
      `${second?.engine}，${Date.now() - again} ms，Google 请求 ${googleRequests - before} 个`
    )
    check(
      '打不开 Google 那一轮隐藏窗口都关掉了',
      blocked.openWindows() === 0,
      `${blocked.openWindows()} 个没关`
    )

    // 像重启之后：新起一份操作、Google 其实打得开的会话，只凭 JSON 文件就跳过 Google
    const restarted = freshOperations()
    const fresh = createPort('google', Partition, createBackoffFile(backoffPath))
    const afterRestart = await restarted.search(
      { query: 'Electron session partition', limit: 5 },
      contextOf(fresh.port)
    )
    check(
      '重启之后照 JSON 文件里的退避直接走 Bing',
      afterRestart.engine === 'bing' &&
        fresh.loads.every((load) => !load.url.startsWith('https://www.google.com/')),
      `${afterRestart.engine}，${afterRestart.results.length} 条`
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
    await down.clearStorageData()
  }
}

async function run() {
  const hidden = session.fromPartition(Partition)
  // 正常的 Chrome UA：去掉 Electron 那一段，搜索引擎更少把它当机器人
  hidden.setUserAgent(hidden.getUserAgent().replace(/\s(?:Electron|electron-web-probe)\/\S+/gu, ''))
  hidden.on('will-download', (event) => event.preventDefault())
  hidden.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  info(`UA：${hidden.getUserAgent()}`)

  const fixtures = await startFixtures()
  const local = createPort('google')
  try {
    await fixtureSuite(local.port, fixtures.origin)
    check('夹具页跑完隐藏窗口都关掉了', local.openWindows() === 0, `${local.openWindows()} 个没关`)
  } finally {
    fixtures.close()
  }
  await liveSuite()
  // 最后跑：它用自己新起的操作量换 Bing，不受前面真搜的影响
  await googleDownSuite()
  await hidden.clearStorageData()
}

// 隐藏窗口关完时 Electron 默认就退出了：探针自己决定什么时候退。
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
