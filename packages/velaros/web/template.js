// velaros:web 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 搜索和读网页都在一个不显示的浏览器里跑；要在网页上点、填、登录，用浏览器，不用这个。
import { read, search } from 'velaros:web'

// 搜一次，看标题、地址与摘要：结果只是线索，engine 是实际用的搜索引擎（Google 搜不通时换成了 Bing）。
async function lookup(query = 'Node.js 事件循环') {
  const { engine, results } = await search({ query, limit: 5 })
  return { engine, results: results.map(({ title, url, snippet }) => ({ title, url, snippet })) }
}

// 读一个网页的开头：够判断是不是要找的那一页；nextOffset 不是 null 就是还没读完。
async function skim(url = 'https://nodejs.org/en/learn') {
  const page = await read({ url, maxChars: 3000 })
  return { title: page.title, url: page.url, totalChars: page.totalChars, head: page.text, more: page.nextOffset !== null }
}

// 整页读完：拿 nextOffset 当 offset 一段段接着读，拼成全文。每次 read 都重新打开网页，所以一次读满 20000 个字符。
async function readAll(url = 'https://nodejs.org/en/learn') {
  let offset = 0
  let text = ''
  for (;;) {
    const page = await read({ url, offset, maxChars: 20000 })
    text += page.text
    if (page.nextOffset === null) return { title: page.title, url: page.url, text }
    offset = page.nextOffset
  }
}

// 在网页里找关键词所在的段落：正文在程序里筛，只把用得上的几段交出去。
async function findInPage(url = 'https://nodejs.org/en/learn', keyword = /event loop|事件循环/i) {
  const page = await read({ url, maxChars: 20000 })
  const paragraphs = page.text.split('\n\n').filter((paragraph) => keyword.test(paragraph))
  return { url: page.url, found: paragraphs.slice(0, 5) }
}

// 搜完读前几条的原文，带上出处：读不了的那条单独记下原因（error.code），别的照常。
async function research(query = 'Bun 和 Node.js 的区别', count = 3) {
  const { results } = await search({ query, limit: count })
  const sources = []
  for (const result of results) {
    try {
      const page = await read({ url: result.url, maxChars: 4000 })
      sources.push({ title: page.title, url: page.url, text: page.text })
    } catch (error) {
      sources.push({ title: result.title, url: result.url, failed: `${error.code}：${error.message}` })
    }
  }
  return sources
}

// 两个搜索引擎都搜不了时抛 WEB_SEARCH_FAILED：message 写着两边各自为什么，照实告诉用户。
async function searchOrExplain(query = 'VelarOS 发布说明') {
  try {
    return await search({ query })
  } catch (error) {
    if (error.code === 'WEB_SEARCH_FAILED') return { failed: error.message }
    throw error
  }
}
