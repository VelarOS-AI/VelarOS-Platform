// 真机探针：内嵌页面的整页截图与高过一屏的区域截图。bun test 不跑它。
// 历史事故：<webview> 只按元素那么大出画面，captureBeyondViewport 一次截整页时，超出一屏的部分是第一屏反复平铺；
// 现在按一屏切块截再拼。这里用真的 <webview>（宿主窗口里按模拟视口的大小摆着、再按比例缩放，和 Desktop 舞台一样）
// 与不显示的后台窗口两种页面，经运行时的 setViewport 与 captureScreenshot 截一张长网格页：每格印着自己行列号的黑白条码，
// 解码核对每格都在自己的位置上；fixed 顶栏只出现一次、在它此刻所在的位置；截图不滚动页面。
// 宿主接了 onPageCaptureFreeze 时，界面里的 <webview> 截之前先拿到此刻这一屏的定格图、截完拿到 null；后台窗口不叫。
// 跑法（先在 packages/velaros 下 bun run build），在 Platform 根：
//   perl -e 'alarm 240; exec @ARGV' node_modules/electron/dist/Electron.app/Contents/MacOS/Electron packages/velaros/browser/test/probes/electron-full-page-screenshot.probe.mjs
// 产品里用的 Electron 版本不同时，换成产品仓 node_modules 里的 Electron 再跑一遍。每一项打一行 ✓ 或 ✗，全过退出码 0。
// 只验 screenshot.width/height 临时视口与恢复可追加 --viewport-only；全部窗口保持隐藏，不接现有产品页面。
// Windows 从未显示的窗口可能没有合成帧；追加 --offscreen 使用真正离屏合成，仍核对原 PNG/网格断言。
// --report=<绝对路径> 直接保存核验日志，避免 GUI 子系统吞 stdout；--diagnostic 另记录 CDP 阶段。
import { appendFileSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { app, BrowserWindow, nativeImage } from 'electron'

import { createElectronBrowserRuntime } from '../../../dist/browser/electron.js'

const results = []
const reportPath = process.argv.find((argument) => argument.startsWith('--report='))?.slice(9)
const report = (message) => {
  console.info(message)
  if (reportPath) appendFileSync(reportPath, `${message}\n`)
}
// Give this standalone test its own Chromium profile and a bounded lifetime.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'velaros-screenshot-profile-')))
const deadlineSeconds = process.argv.includes('--viewport-only') ? 120 : 240
const deadline = setTimeout(() => {
  report(`✗ 探针超过 ${deadlineSeconds} 秒，退出自有 Electron 进程`)
  app.exit(1)
}, deadlineSeconds * 1000)

/** 一格的底色：只为看图时分得清，核对只看黑白条码。 */
const cellColor = (row, column) => [
  30 + ((row * 53 + column * 101) % 197),
  30 + ((row * 29 + column * 67 + 90) % 197),
  30 + ((row * 83 + column * 13 + 45) % 197),
]

/**
 * 长网格页：rows 行、columns 列，每格 100×100，左上角的白底条码是它的行号（7 位）与列号（5 位），黑块是 0。
 * 顶上一条 30 像素高的 fixed 洋红顶栏；button 给一个按钮（元素标注会给它画框）。
 * 隐藏原生滚动条，避免 Windows 固定滚动条与 macOS overlay 滚动条改变内容区宽度；仍严格核对 PNG 像素与滚动位置。
 */
function gridPage({ rows, columns, meta, button }) {
  const viewportMeta = meta
    ? '<meta name="viewport" content="width=device-width, initial-scale=1">'
    : ''
  const buttonMarkup = button
    ? `<button id="probe-button" style="position:absolute;left:${button.x}px;top:${button.y}px;width:90px;height:40px;z-index:5">按钮</button>`
    : ''
  return `<!doctype html><html><head><title>网格</title>${viewportMeta}<style>
html,body{margin:0;padding:0}
html{scrollbar-width:none}::-webkit-scrollbar{display:none}
.band{height:100px;display:flex}
.cell{flex:none;width:100px;height:100px;position:relative}
.code{position:absolute;left:5px;top:5px;width:88px;height:32px;background:#fff}
.bit{position:absolute;width:10px;height:10px;background:#000}
#fixed{position:fixed;top:0;left:0;right:0;height:30px;background:rgb(255,0,255);z-index:9}
</style></head><body><div id="grid"></div><div id="fixed"></div>${buttonMarkup}<script>
const rows = ${rows}, columns = ${columns}
const cellColor = ${cellColor.toString()}
const grid = document.getElementById('grid')
for (let row = 0; row < rows; row++) {
  const band = document.createElement('div'); band.className = 'band'; band.style.width = columns * 100 + 'px'
  for (let column = 0; column < columns; column++) {
    const cell = document.createElement('div'); cell.className = 'cell'
    cell.style.background = 'rgb(' + cellColor(row, column).join(',') + ')'
    let code = '<div class="code">'
    for (let bit = 0; bit < 7; bit++) if (!((row >> bit) & 1)) code += '<div class="bit" style="left:' + (3 + bit * 11) + 'px;top:3px"></div>'
    for (let bit = 0; bit < 5; bit++) if (!((column >> bit) & 1)) code += '<div class="bit" style="left:' + (3 + bit * 11) + 'px;top:18px"></div>'
    cell.innerHTML = code + '</div>'
    band.appendChild(cell)
  }
  grid.appendChild(band)
}
window.__scrolls = 0
window.addEventListener('scroll', () => { window.__scrolls += 1 })
</script></body></html>`
}

async function startSite() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://probe')
    const button = url.searchParams.get('button')?.split(',').map(Number)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      gridPage({
        rows: Number(url.searchParams.get('rows')),
        columns: Number(url.searchParams.get('columns')),
        meta: url.searchParams.get('meta') === '1',
        button: button ? { x: button[0], y: button[1] } : null,
      })
    )
  })
  await new Promise((resolve) => server.listen(0, 'localhost', resolve))
  return { origin: `http://localhost:${server.address().port}`, close: () => server.close() }
}

/**
 * 读一张截图：capture 是它在页面上的那块（页面 CSS 像素）。解码每个条码完整落在这块里的格子，数认错的格子；
 * 沿 x=97 往下找洋红顶栏，交回它出现的页面纵坐标。
 */
function readGrid(image, capture, rows, columns) {
  const { width, height } = image.getSize()
  const scaleX = width / capture.width
  const scaleY = height / capture.height
  const bitmap = image.toBitmap()
  const pixel = (pageX, pageY) => {
    const x = Math.min(width - 1, Math.max(0, Math.round((pageX - capture.x) * scaleX)))
    const y = Math.min(height - 1, Math.max(0, Math.round((pageY - capture.y) * scaleY)))
    const offset = (y * width + x) * 4
    return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
  }
  const bitAt = (pageX, pageY) =>
    pixel(pageX, pageY).reduce((sum, value) => sum + value, 0) > 384 ? 1 : 0
  let checked = 0
  const wrong = []
  for (let row = 0; row < rows; row++) {
    const top = row * 100
    if (top + 5 < capture.y || top + 40 > capture.y + capture.height) continue
    for (let column = 0; column < columns; column++) {
      const left = column * 100
      if (left + 5 < capture.x || left + 95 > capture.x + capture.width) continue
      let readRow = 0
      let readColumn = 0
      for (let bit = 0; bit < 7; bit++) readRow |= bitAt(left + 13 + bit * 11, top + 13) << bit
      for (let bit = 0; bit < 5; bit++) readColumn |= bitAt(left + 13 + bit * 11, top + 28) << bit
      checked += 1
      if (readRow !== row || readColumn !== column) wrong.push({ row, column, readRow, readColumn })
    }
  }
  const header = []
  let inHeader = false
  for (let pageY = capture.y; pageY < capture.y + capture.height; pageY += 2) {
    const [red, green, blue] = pixel(capture.x + 97, pageY)
    const magenta = red > 200 && green < 90 && blue > 200
    if (magenta && !inHeader) header.push(pageY)
    inHeader = magenta
  }
  return { checked, wrong, header, pixel }
}

/** 记一行检查结果。 */
const checkerOf =
  (label) =>
  (name, ok, detail = '') => {
    results.push(ok)
    report(`${ok ? '✓' : '✗'} [${label}] ${name}${detail ? `：${detail}` : ''}`)
  }

/** 元素标注框的蓝（rgba(10,132,255,0.88) 叠在按钮上）：蓝为主、红低。 */
const isLabelBlue = ([red, green, blue]) => blue > 170 && red < 140 && green > 70 && green < 200

/** 格子里只有顶栏盖住的那一行认不出（条码被洋红盖住），其余都要对。 */
function checkGrid(check, reading, headerRow) {
  const unexpected = reading.wrong.filter((cell) => cell.row !== headerRow)
  check(
    '每一格都在自己的位置上（没有平铺、没有空白）',
    reading.checked > 0 && unexpected.length === 0,
    `核对 ${reading.checked} 格，错 ${unexpected.length} 格${unexpected.length ? `，如 ${JSON.stringify(unexpected.slice(0, 3))}` : ''}`
  )
}

/** 宿主窗口里摆一个 <webview>：按模拟视口的大小排版、再按比例缩小显示，和 Desktop 舞台一样。 */
async function openWebviewStage(url, size, displayScale) {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      webviewTag: true,
      backgroundThrottling: false,
      offscreen: process.argv.includes('--offscreen'),
    },
  })
  const guestReady = new Promise((resolve) => {
    window.webContents.once('did-attach-webview', (_event, guest) => {
      guest.once('did-finish-load', () => resolve(guest))
    })
  })
  const host = `<!doctype html><html><body style="margin:0;background:#222">
<div style="position:absolute;left:0;top:0;width:${size.width}px;height:${size.height}px;transform:scale(${displayScale});transform-origin:top left">
<webview src="${url}" style="position:absolute;left:0;top:0;width:100%;height:100%"></webview></div></body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(host)}`)
  return { window, page: await guestReady }
}

/** 不显示的窗口直接载入页面：Desktop 的后台页面就是这种。 */
async function openWindowStage(url) {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      backgroundThrottling: false,
      offscreen: process.argv.includes('--offscreen'),
    },
  })
  await window.loadURL(url)
  return { window, page: window.webContents }
}

const pageState = (page) =>
  page.executeJavaScript(
    '({ scrollY: window.scrollY, scrolls: window.__scrolls, innerWidth: window.innerWidth, innerHeight: window.innerHeight })',
    true
  )

/** 截一张图、读回来：返回回执与解码结果。 */
async function shoot(runtime, sessionId, context, options, rows, columns) {
  const artifact = await runtime.captureScreenshot(sessionId, context, {
    waitForNetworkIdle: false,
    waitForDomStable: false,
    ...options,
  })
  const image = nativeImage.createFromPath(artifact.path)
  return { artifact, reading: readGrid(image, artifact.capture, rows, columns) }
}

async function scenario(runtime, site, workspaceRoot, spec, freezes) {
  const check = checkerOf(spec.label)
  const query = new URLSearchParams({
    rows: String(spec.rows),
    columns: String(spec.columns),
    meta: spec.meta ? '1' : '0',
  })
  if (spec.button) query.set('button', spec.button.join(','))
  const url = `${site.origin}/?${query}`
  const stage =
    spec.stage === 'window'
      ? await openWindowStage(url)
      : await openWebviewStage(url, spec.viewport, spec.displayScale)
  const sessionId = `full-page-${spec.label}`
  const context = { url, workspaceRoot }
  try {
    await runtime.presentPage(sessionId, context, stage.page.id)
    await runtime.setViewport(sessionId, context, spec.viewport)
    if (spec.scrollY) {
      await stage.page.executeJavaScript(
        `new Promise((resolve) => { window.scrollTo(0, ${spec.scrollY}); requestAnimationFrame(() => requestAnimationFrame(resolve)) })`,
        true
      )
    }
    const before = await pageState(stage.page)
    const started = Date.now()
    const { artifact, reading } = await shoot(
      runtime,
      sessionId,
      context,
      spec.options,
      spec.rows,
      spec.columns
    )
    const elapsed = Date.now() - started
    const after = await pageState(stage.page)
    const capture = artifact.capture
    const expectedMode = spec.options.region ? 'region' : 'full-page'

    check(
      `截到的是 ${expectedMode}，范围 ${spec.expected.width}×${spec.expected.height}`,
      capture.mode === expectedMode &&
        capture.width === spec.expected.width &&
        capture.height === spec.expected.height &&
        capture.clipped === false,
      `${capture.mode} ${capture.x},${capture.y} ${capture.width}×${capture.height}，图 ${artifact.width}×${artifact.height}，${elapsed}ms`
    )
    checkGrid(check, reading, Math.floor((spec.scrollY ?? 0) / 100))
    if (!spec.options.region || spec.options.region.y === 0) {
      check(
        'fixed 顶栏只出现一次、在它此刻所在的位置',
        reading.header.length === 1 && Math.abs(reading.header[0] - (spec.scrollY ?? 0)) <= 2,
        `顶栏出现在 ${JSON.stringify(reading.header)}`
      )
    }
    check(
      '截图不滚动页面，滚动位置不变',
      after.scrolls === before.scrolls && after.scrollY === before.scrollY,
      `滚动事件 ${after.scrolls - before.scrolls} 次，位置 ${before.scrollY} → ${after.scrollY}`
    )
    const mine = freezes.filter((entry) => entry.sessionId === sessionId)
    freezes.length = 0
    if (spec.stage === 'window') {
      check('后台窗口看不见，不请宿主定格', mine.length === 0, `定格 ${mine.length} 次`)
    } else {
      const [freeze, release] = mine
      const frozen = freeze?.frame
        ? readGrid(
            nativeImage.createFromDataURL(freeze.frame.dataUrl),
            { x: 0, y: spec.scrollY ?? 0, width: before.innerWidth, height: before.innerHeight },
            spec.rows,
            spec.columns
          )
        : null
      check(
        '截之前请宿主用此刻这一屏盖住页面，截完请它拿掉',
        mine.length === 2 && !!freeze?.frame && release?.frame === null && release.at >= freeze.at,
        `定格 ${mine.length} 次${freeze?.frame ? `，图 ${freeze.frame.width}×${freeze.frame.height}` : ''}`
      )
      check(
        '定格图就是截之前的那一屏（没有编号框）',
        !!frozen &&
          frozen.checked > 0 &&
          frozen.wrong.filter((cell) => cell.row !== Math.floor((spec.scrollY ?? 0) / 100))
            .length === 0 &&
          (!spec.button || !isLabelBlue(frozen.pixel(spec.button[0] + 45, spec.button[1] + 1))),
        frozen ? `核对 ${frozen.checked} 格，错 ${frozen.wrong.length} 格` : '没有定格图'
      )
    }
    if (spec.options.fullPage) {
      check(
        '回执里的视口是截图时用户看到的位置',
        capture.viewport.y === (spec.scrollY ?? 0) &&
          capture.viewport.height === before.innerHeight &&
          capture.documentHeight === spec.rows * 100,
        `视口 ${JSON.stringify(capture.viewport)}，整页高 ${capture.documentHeight}`
      )
    }
    if (spec.button) {
      const [x, y] = spec.button
      const [red, green, blue] = reading.pixel(x + 45, y + 1)
      check(
        '元素标注的框画在按钮所在的页面位置上',
        isLabelBlue([red, green, blue]),
        `框上的像素 rgb(${red},${green},${blue})`
      )
    }
    if (spec.options.includeModelImage) {
      const map = artifact.modelImage?.coordinateMap
      const expectedTop =
        ((spec.scrollY ?? 0) * (artifact.modelImage?.height ?? 0)) / capture.height
      check(
        '给模型的图里，当前视口框在对应的位置',
        !!map && Math.abs(map.viewportRectInImage.y - expectedTop) <= 2,
        map ? `视口框 y=${map.viewportRectInImage.y}，应在 ${expectedTop.toFixed(1)}` : '没有模型图'
      )
    }
  } finally {
    await runtime.closeSession(sessionId)
    stage.window.destroy()
  }
}

/** 只经 screenshot 的尺寸参数连续缩窄，不能先调用 setViewport 掩盖截图入口丢参。 */
async function screenshotViewportScenario(runtime, site, workspaceRoot, kind) {
  const check = checkerOf(`截图尺寸·${kind}`)
  const url = `${site.origin}/?rows=12&columns=3&meta=1`
  report(`阶段 ${kind}: 创建隐藏页面`)
  const stage =
    kind === 'window'
      ? await openWindowStage(url)
      : await openWebviewStage(url, { width: 1280, height: 900 }, 0.5)
  const sessionId = `screenshot-viewport-${kind}`
  const context = { url, workspaceRoot }
  try {
    report(`阶段 ${kind}: presentPage`)
    await runtime.presentPage(sessionId, context, stage.page.id)
    if (process.argv.includes('--diagnostic')) {
      const sendCommand = stage.page.debugger.sendCommand.bind(stage.page.debugger)
      stage.page.debugger.sendCommand = async (method, ...args) => {
        report(`CDP 开始 ${method}`)
        const value = await sendCommand(method, ...args)
        report(`CDP 完成 ${method}`)
        return value
      }
      const capturePage = stage.page.capturePage.bind(stage.page)
      stage.page.capturePage = async (...args) => {
        report(`原生 capturePage 开始 ${JSON.stringify(await pageState(stage.page))}`)
        const image = await capturePage(...args)
        report(`原生 capturePage 完成 ${JSON.stringify(image.getSize())}`)
        return image
      }
    }
    const original = await pageState(stage.page)
    for (const dimensions of [
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      report(`阶段 ${kind}: screenshot ${dimensions.width}×${dimensions.height}`)
      const { artifact, reading } = await shoot(
        runtime,
        sessionId,
        context,
        {
          ...dimensions,
          fullPage: true,
          includeModelImage: false,
          path: `viewport-${kind}-${dimensions.width}.png`,
        },
        12,
        3
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      const actual = await pageState(stage.page)
      report(`阶段 ${kind}: 实测 ${JSON.stringify(actual)}，PNG ${artifact.path}`)
      const pixels = nativeImage.createFromPath(artifact.path).getSize()
      check(
        `screenshot ${dimensions.width}×${dimensions.height} 结束后恢复自然视口`,
        actual.innerWidth === original.innerWidth && actual.innerHeight === original.innerHeight,
        `实际 ${actual.innerWidth}×${actual.innerHeight}`
      )
      check(
        '实际 PNG 与回执宽度一致，仍捕获完整长页而非缩放旧图',
        pixels.width === dimensions.width &&
          artifact.width === pixels.width &&
          pixels.height === 1200 &&
          artifact.height === pixels.height &&
          artifact.capture.mode === 'full-page',
        `PNG ${pixels.width}×${pixels.height}，回执 ${artifact.width}×${artifact.height}`
      )
      checkGrid(check, reading, 0)
    }
    const subsequent = await runtime.captureScreenshot(sessionId, context, {
      path: `viewport-${kind}-retained.png`,
      fullPage: true,
      includeModelImage: false,
    })
    const retained = await pageState(stage.page)
    check(
      '随后不带尺寸的截图使用自然视口',
      retained.innerWidth === original.innerWidth &&
        retained.innerHeight === original.innerHeight &&
        subsequent.width === original.innerWidth,
      `视口 ${retained.innerWidth}×${retained.innerHeight}，PNG 宽 ${subsequent.width}`
    )
    if (kind !== 'window') {
      await stage.window.webContents.executeJavaScript(
        `document.querySelector('webview').parentElement.style.width='1040px'`
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      const resized = await pageState(stage.page)
      check(
        '截图后 webview 继续跟随宿主布局调整',
        resized.innerWidth === 1040,
        JSON.stringify(resized)
      )
    }
    await runtime.setViewport(sessionId, context, { width: 960, height: 720, mobile: false })
    await runtime.captureScreenshot(sessionId, context, {
      width: 820,
      height: 820,
      path: `restore-host-${kind}.png`,
      includeModelImage: false,
      waitForNetworkIdle: false,
      waitForDomStable: false,
    })
    const hostViewport = await pageState(stage.page)
    check(
      '保留显式宿主视口',
      hostViewport.innerWidth === 960 && hostViewport.innerHeight === 720,
      JSON.stringify(hostViewport)
    )
    await runtime.sendProtocolCommand(sessionId, context, {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: 720,
        height: 540,
        mobile: false,
        deviceScaleFactor: 2,
        screenWidth: 720,
        screenHeight: 540,
      },
    })
    await runtime.captureScreenshot(sessionId, context, {
      width: 820,
      height: 820,
      path: `restore-model-${kind}.png`,
      includeModelImage: false,
      waitForNetworkIdle: false,
      waitForDomStable: false,
    })
    const modelViewport = await pageState(stage.page)
    const dpr = await stage.page.executeJavaScript('devicePixelRatio')
    check(
      '保留模型 CDP 视口与 DPR',
      modelViewport.innerWidth === 720 && modelViewport.innerHeight === 540 && dpr === 2,
      `${JSON.stringify(modelViewport)}, DPR ${dpr}`
    )
    for (let round = 0; round < 6; round++) {
      const fullPage = round % 2 === 1
      const artifact = await runtime.captureScreenshot(sessionId, context, {
        width: 820,
        height: 820,
        path: `compositor-${kind}-${round}.png`,
        includeModelImage: false,
        fullPage,
        waitForNetworkIdle: false,
        waitForDomStable: false,
      })
      const pixels = nativeImage.createFromPath(artifact.path).getSize()
      check(
        `快速切换 DPR 后${fullPage ? '整页' : '视口'}截图尺寸准确（${round + 1}/6）`,
        pixels.width === 820 && pixels.height === (fullPage ? 1200 : 820),
        `PNG ${pixels.width}×${pixels.height}`
      )
      checkGrid(
        check,
        readGrid(nativeImage.createFromPath(artifact.path), artifact.capture, 12, 3),
        0
      )
    }
    let rejected = false
    try {
      await runtime.captureScreenshot(sessionId, context, {
        width: 820,
        height: 820,
        path: '../outside.png',
        includeModelImage: false,
        waitForNetworkIdle: false,
        waitForDomStable: false,
      })
    } catch {
      rejected = true
    }
    const failedViewport = await pageState(stage.page)
    check(
      '截图落盘失败后仍还原显式视口',
      rejected && failedViewport.innerWidth === 720 && failedViewport.innerHeight === 540,
      JSON.stringify(failedViewport)
    )
    const cancellation = new AbortController()
    const sendCommand = stage.page.debugger.sendCommand.bind(stage.page.debugger)
    stage.page.debugger.sendCommand = async (method, ...args) => {
      const result = await sendCommand(method, ...args)
      if (method === 'Emulation.setDeviceMetricsOverride' && args[0].width === 820)
        cancellation.abort(new Error('probe cancellation after resize'))
      return result
    }
    let cancelled = false
    try {
      await runtime.captureScreenshot(
        sessionId,
        context,
        { width: 820, height: 820, path: `cancelled-${kind}.png` },
        cancellation.signal
      )
    } catch (error) {
      cancelled = /probe cancellation/.test(error.message)
    } finally {
      stage.page.debugger.sendCommand = sendCommand
    }
    const cancelledViewport = await pageState(stage.page)
    check(
      '设置视口后取消仍还原',
      cancelled && cancelledViewport.innerWidth === 720 && cancelledViewport.innerHeight === 540,
      JSON.stringify(cancelledViewport)
    )
  } finally {
    await runtime.closeSession(sessionId)
    stage.window.destroy()
  }
}

const Desktop = { width: 1440, height: 900, mobile: false }
const Phone = { width: 390, height: 844, mobile: true }

const Scenarios = [
  {
    label: '内嵌·桌面 1440×900',
    viewport: Desktop,
    displayScale: 0.5,
    rows: 60,
    columns: 14,
    meta: true,
    options: { fullPage: true },
    expected: { width: 1440, height: 6000 },
  },
  {
    label: '内嵌·手机 390×844',
    viewport: Phone,
    displayScale: 0.8,
    rows: 60,
    columns: 3,
    meta: true,
    options: { fullPage: true },
    expected: { width: 390, height: 6000 },
  },
  {
    label: '内嵌·手机、页面没写 meta viewport',
    viewport: Phone,
    displayScale: 0.8,
    rows: 40,
    columns: 9,
    meta: false,
    options: { fullPage: true },
    expected: { width: 980, height: 4000 },
  },
  {
    label: '内嵌·横竖都超出一屏',
    viewport: Desktop,
    displayScale: 0.5,
    rows: 30,
    columns: 20,
    meta: true,
    options: { fullPage: true },
    expected: { width: 2000, height: 3000 },
  },
  {
    label: '内嵌·滚到中间、带元素标注与模型图',
    viewport: Desktop,
    displayScale: 0.5,
    rows: 60,
    columns: 14,
    meta: true,
    scrollY: 1500,
    button: [405, 1645],
    options: { fullPage: true, annotateElements: true, includeModelImage: true },
    expected: { width: 1440, height: 6000 },
  },
  {
    label: '内嵌·高过一屏的区域',
    viewport: Desktop,
    displayScale: 0.5,
    rows: 60,
    columns: 14,
    meta: true,
    options: { region: { x: 0, y: 0, width: 300, height: 2500 } },
    expected: { width: 300, height: 2500 },
  },
  {
    label: '内嵌·一屏外的小区域',
    viewport: Desktop,
    displayScale: 0.5,
    rows: 60,
    columns: 14,
    meta: true,
    options: { region: { x: 100, y: 3000, width: 400, height: 500 } },
    expected: { width: 400, height: 500 },
  },
  {
    label: '后台窗口·桌面 1440×900',
    stage: 'window',
    viewport: Desktop,
    rows: 60,
    columns: 14,
    meta: true,
    options: { fullPage: true },
    expected: { width: 1440, height: 6000 },
  },
  {
    label: '后台窗口·手机 390×844',
    stage: 'window',
    viewport: Phone,
    rows: 60,
    columns: 3,
    meta: true,
    options: { fullPage: true },
    expected: { width: 390, height: 6000 },
  },
]

// 关掉最后一个窗口时 Electron 默认就退出：探针自己决定什么时候退。
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  app.dock?.hide()
  const site = await startSite()
  const freezes = []
  const runtime = createElectronBrowserRuntime({
    // 宿主替身：记下每次定格与拿掉；盖上定格图要一点时间（界面解图、画出来），这里等 30 毫秒再结算。
    onPageCaptureFreeze: async (sessionId, frame) => {
      freezes.push({ sessionId, frame, at: Date.now() })
      if (frame) await new Promise((resolve) => setTimeout(resolve, 30))
    },
  })
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'velaros-full-page-probe-'))
  report(
    `Electron ${process.versions.electron}，offscreen=${process.argv.includes('--offscreen')}，截图落在 ${workspaceRoot}`
  )
  try {
    if (!process.argv.includes('--viewport-only')) {
      for (const spec of Scenarios) await scenario(runtime, site, workspaceRoot, spec, freezes)
    }
    for (const kind of ['window', 'webview']) {
      await screenshotViewportScenario(runtime, site, workspaceRoot, kind)
    }
  } catch (error) {
    results.push(false)
    report(`✗ 探针没跑完：${error.stack}`)
  }
  runtime.dispose()
  site.close()
  const passed = results.filter(Boolean).length
  report(`\n${passed}/${results.length} 通过`)
  clearTimeout(deadline)
  app.exit(passed === results.length ? 0 : 1)
})
