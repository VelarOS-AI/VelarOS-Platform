// 通过 nodeSubprocessCodeRunner 执行模型程序的用例仅适用 POSIX；直接端口测试在所有平台运行。
/**
 * 代码模版是给模型看的日常用法示例：只过类型检查不够，结果取错一个键、写法跑不通，模型照着写就跟着错。
 * 这里把模版的每个函数接在假无头浏览器上，经真的代码面会话调一遍——和模型交程序是同一条路；搜索结果与网页都是写好的，钟是假钟。
 */

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { VelarWebModule, WebErrorCodes } from '../index'
import type { FakeSite } from '../spec/support'
import { runModelProgram, scanOf, webSpace } from '../spec/support'

const it = test.skipIf(process.platform === 'win32')

/** 模版里读的那一页：三百段，每五十段有一段讲 event loop，整页比一次最多能读的还长，readAll 要接着读。 */
const Learn = Array.from({ length: 300 }, (_, index) =>
  index % 50 === 0 ? `第 ${index} 段讲 event loop 的事。` : `第 ${index} 段：${'内容'.repeat(40)}`
).join('\n\n')

/** 搜索结果：两个读得开的网页、一个打不开的。 */
const Results = scanOf([
  { title: 'Bun 文档', href: 'https://bun.sh/docs', snippet: 'Bun 是……' },
  { title: 'Node.js 学习', href: 'https://nodejs.org/en/learn', snippet: '事件循环……' },
  { title: '坏链接', href: 'https://broken.example/' },
])

/** 假浏览器里的站：搜 VelarOS 时两个搜索引擎都打不开，别的搜索都交回上面那几条。 */
function site(url: string): FakeSite {
  if (url.includes('VelarOS')) return { load: new AppError('NETWORK', 'net::ERR_CONNECTION_RESET') }
  if (url.startsWith('https://www.google.com/search')) return { scan: Results }
  if (url === 'https://nodejs.org/en/learn')
    return { readable: { title: 'Node.js 学习', text: Learn, contentType: 'text/html' } }
  if (url === 'https://bun.sh/docs')
    return {
      readable: {
        title: 'Bun 文档',
        text: 'Bun 是一个 JavaScript 运行时。',
        contentType: 'text/html',
      },
    }
  return { load: new AppError('NETWORK', 'net::ERR_NAME_NOT_RESOLVED') }
}

describe('代码模版', () => {
  it('每个函数照写法跑通：搜一次、读开头、整页读完、找段落、搜完读原文、两边都搜不了时照实说', async () => {
    const space = webSpace({ sites: site })
    const outcome = await runModelProgram(
      space,
      `${VelarWebModule.template}
export const found = await lookup()
export const head = await skim()
export const all = await readAll()
export const hits = await findInPage()
export const sources = await research()
export const explained = await searchOrExplain()
`,
      60_000
    )
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.found).toEqual({
      engine: 'google',
      results: [
        { title: 'Bun 文档', url: 'https://bun.sh/docs', snippet: 'Bun 是……' },
        { title: 'Node.js 学习', url: 'https://nodejs.org/en/learn', snippet: '事件循环……' },
        { title: '坏链接', url: 'https://broken.example/', snippet: '' },
      ],
    })
    expect(values.head).toEqual({
      title: 'Node.js 学习',
      url: 'https://nodejs.org/en/learn',
      totalChars: Learn.length,
      head: Learn.slice(0, 3000),
      more: true,
    })
    expect(values.all).toEqual({
      title: 'Node.js 学习',
      url: 'https://nodejs.org/en/learn',
      text: Learn,
    })
    expect(values.hits).toEqual({
      url: 'https://nodejs.org/en/learn',
      found: Learn.slice(0, 20000)
        .split('\n\n')
        .filter((paragraph) => /event loop|事件循环/iu.test(paragraph))
        .slice(0, 5),
    })
    expect(values.hits.found.length).toBeGreaterThan(1)
    expect(values.sources).toEqual([
      { title: 'Bun 文档', url: 'https://bun.sh/docs', text: 'Bun 是一个 JavaScript 运行时。' },
      { title: 'Node.js 学习', url: 'https://nodejs.org/en/learn', text: Learn.slice(0, 4000) },
      {
        title: '坏链接',
        url: 'https://broken.example/',
        failed: `${WebErrorCodes.pageUnreachable}：打不开 https://broken.example/：net::ERR_NAME_NOT_RESOLVED`,
      },
    ])
    expect(values.explained.failed).toContain('VelarOS 发布说明')
    expect(space.record.opened).toBe(space.record.closed)
  }, 90_000)
})
