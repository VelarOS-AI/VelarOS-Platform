// velaros:browser 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 读页面、取数据、改 DOM 在 evaluate 里写 JavaScript；要真实输入（isTrusted、悬停、回车提交、富文本编辑器）用 click、fill、press 与 mouse、key 那几个。
import { click, evaluate, fill, frames, handleDownload, inspect, keyDown, keyUp, mouseDown, mouseMove, mouseUp, open, press, screenshot, waitForEvent, waitForFunction } from 'velaros:browser'

// 打开一个网站，看看页面上有什么：标题、前几个小标题、可以点的东西。
async function look(url = 'https://example.com') {
  await open({ url })
  const page = await inspect({ maxTextChars: 4000 })
  return {
    title: page.title,
    headings: page.headings.slice(0, 5).map((heading) => heading.text),
    actions: page.actions.slice(0, 10).map((action) => ({ text: action.text, target: action.target })),
  }
}

// 把表格读成二维数组：选择器用 args 传进去，别拼进源码。
async function readRows(selector = 'table tbody tr') {
  return evaluate({
    script: '(sel) => [...document.querySelectorAll(sel)].map((row) => [...row.cells].map((cell) => cell.innerText.trim()))',
    args: [selector],
  })
}

// 站内搜索：真实输入填词、回车，等结果出来再按条读。
async function search(query = 'velaros') {
  await fill({ target: 'input[type=search], input[name=q]', value: query })
  await press({ key: 'Enter' })
  await waitForFunction({ script: "document.querySelectorAll('.result').length > 0", timeoutMs: 10000 })
  return evaluate({
    script: "[...document.querySelectorAll('.result')].map((item) => ({ title: item.querySelector('h3, a')?.innerText, href: item.querySelector('a')?.href }))",
  })
}

// 填一张表单：文字用 fill，勾选框用 click，下拉框在页面里设值再派发 change，最后等成功提示。
async function submitForm(email = 'user@example.com', country = 'CN') {
  await fill({ target: 'input[name=email]', value: email })
  await click({ target: 'input[name=agree]' })
  await evaluate({
    script: "(value) => { const select = document.querySelector('select[name=country]'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); return select.value }",
    args: [country],
  })
  await click({ target: 'button[type=submit]' })
  return waitForFunction({ script: "document.body.innerText.includes('提交成功')", timeoutMs: 10000 })
}

// 翻页收集：每页读一遍，点下一页，等第一条变了再读，直到没有下一页。
async function collectPages(maxPages = 3) {
  const items = []
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await evaluate({ script: "[...document.querySelectorAll('.result a')].map((link) => ({ title: link.innerText, href: link.href }))" })
    items.push(...rows)
    const hasNext = await evaluate({ script: "!!document.querySelector('a[rel=next]')" })
    if (!hasNext) break
    const first = rows[0]?.href
    await click({ target: 'a[rel=next]' })
    await waitForFunction({ script: "(previous) => document.querySelector('.result a')?.href !== previous", args: [first] })
  }
  return items
}

// 看图定位：截一张带编号的图（图会交给你看），按编号对应的 target 去点。
async function clickByLook(label = '登录') {
  const shot = await screenshot({ annotate: true })
  const item = shot.legend?.find((entry) => entry.text?.includes(label))
  if (!item) return { clicked: false, screenshot: shot.relativePath }
  const result = await click({ target: item.target })
  return { clicked: result.matched, screenshot: shot.relativePath }
}

// 按住拖出一条路径（滑块、画布、地图）：先在页面里量出元素的位置，再用鼠标原子一步步拖。
async function dragHandle(selector = '.slider-handle', distance = 200) {
  const box = await evaluate({
    script: '(sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }',
    args: [selector],
  })
  await mouseMove({ x: Math.round(box.x), y: Math.round(box.y) })
  await mouseDown({})
  await mouseMove({ x: Math.round(box.x + distance), y: Math.round(box.y), steps: 20 })
  return mouseUp({})
}

// 按住 Shift 连选：keyDown 之后的点击都带着 Shift，最后记得 keyUp。
async function shiftSelect(first = '.row:nth-child(1)', last = '.row:nth-child(5)') {
  await click({ target: first })
  await keyDown({ key: 'Shift' })
  await click({ target: last })
  return keyUp({ key: 'Shift' })
}

// 读 iframe 里的内容（跨源的也行）：frames() 找到它的 id，evaluate 带上 frame。
async function readFrame(urlPart = 'checkout') {
  const frame = (await frames()).find((candidate) => candidate.url.includes(urlPart))
  if (!frame) return null
  return evaluate({ script: 'document.body.innerText.slice(0, 2000)', frame: frame.id })
}

// 点下载链接，等下载事件出来，存进站点工作区。
async function saveDownload(linkText = '下载报告', savePath = 'downloads/report.pdf') {
  await click({ target: { text: linkText } })
  const event = await waitForEvent({ kind: 'download', timeoutMs: 10000 })
  const handled = await handleDownload({ eventId: event.id, savePath })
  return { saved: handled.handled, path: handled.savePath }
}
