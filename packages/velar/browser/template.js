// velar:browser 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 先 open 进站点；页面是异步的，动完用 waitFor 那几个等到位再读。元素写 inspect 给的 target、ref（@e3:g2）或 CSS selector。
import { click, content, fill, handleDownload, inspect, list, open, paginate, press, screenshot, table, waitForEvent, waitForLoad, waitForText } from 'velar:browser'

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

// 在站内搜索：找到搜索框填词、回车，等结果出来再按条取。
async function search(query = 'velaros') {
  const page = await inspect({ maxElements: 100 })
  const box = page.formFields.find((field) => field.type === 'search' || /search|搜索/i.test(field.label))
  if (!box?.target) return { found: false }
  await fill({ target: box.target, value: query })
  await press({ key: 'Enter', waitForNavigation: true })
  await waitForLoad({ state: 'networkidle' })
  const results = await list({ selector: '.result', maxItems: 20 })
  return { found: true, results: results.items }
}

// 填一张表单并提交：按标签找字段，填完点提交，等成功提示。
async function submitForm(values = { 邮箱: 'user@example.com', 姓名: '张三' }) {
  const page = await inspect({})
  for (const [label, value] of Object.entries(values)) {
    const field = page.formFields.find((candidate) => candidate.label.includes(label))
    if (field?.target) await fill({ target: field.target, value })
  }
  await click({ target: 'button[type=submit]' })
  const done = await waitForText({ text: '提交成功', timeoutMs: 10000 })
  return { submitted: done.matched }
}

// 看图定位：截一张带编号的图（图会交给你看），按编号对应的 target 去点。
async function clickByLook(label = '登录') {
  const shot = await screenshot({ annotate: true })
  const item = shot.legend?.find((entry) => entry.text?.includes(label))
  if (!item) return { clicked: false, screenshot: shot.relativePath }
  const result = await click({ target: item.target })
  return { clicked: result.matched, screenshot: shot.relativePath }
}

// 把页面上的表格取出来。
async function readTable() {
  const data = await table({ tableIndex: 0 })
  return data.ok ? { headers: data.headers, rows: data.rows.slice(0, 50) } : { error: data.error }
}

// 翻页收集搜索结果（会真的点下一页，先确认在第一页）。
async function collect(selector = '.result') {
  const pages = await paginate({ selector, maxPages: 3 })
  return { pages: pages.pagesVisited, items: pages.items.map((item) => item.title) }
}

// 取正文读文章。
async function readArticle() {
  const article = await content({ format: 'markdown', selector: 'article' })
  return article.ok ? article.content.slice(0, 8000) : '这页上没找到正文'
}

// 点下载链接，等下载事件出来，存进站点工作区。
async function saveDownload(linkText = '下载报告', savePath = 'downloads/report.pdf') {
  await click({ target: { text: linkText } })
  const waited = await waitForEvent({ kind: 'download', timeoutMs: 10000 })
  if (!waited.matched || !waited.event) return { saved: false }
  const handled = await handleDownload({ eventId: waited.event.id, savePath })
  return { saved: handled.handled, path: handled.savePath }
}
