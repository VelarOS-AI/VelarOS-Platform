/**
 * 代码模版是给模型看的日常用法示例：只过类型检查不够，结果取错一个键、写法跑不通，模型照着写就跟着错。
 * 这里把两份模版的每个函数经真的代码面会话调一遍——和模型交程序是同一条路；空间端口是 spec/support.ts 的替身，
 * 按一页固定的假页面回答（表单、表格、列表、诊断、下载事件……）。
 */
import { describe, expect, test } from 'bun:test'

import { VelarBrowserModule, VelarDevtoolsModule } from '../index.js'
import { browserSpace, createHarness, runModelProgram } from '../spec/support.js'

describe('代码模版', () => {
  test('velar:browser：每个函数照写法跑通', async () => {
    const harness = createHarness({ open: false })
    const outcome = await runModelProgram(browserSpace(harness), `${VelarBrowserModule.template}
export const looked = await look()
export const searched = await search()
export const submitted = await submitForm()
export const clicked = await clickByLook()
export const tableRows = await readTable()
export const collected = await collect()
export const article = await readArticle()
export const downloaded = await saveDownload()
`, 120_000)
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.looked).toMatchObject({ title: 'Example Domain', headings: ['Example Domain'] })
    expect(values.looked.actions[0].target.css).toBe('button.login')
    expect(values.searched).toMatchObject({ found: true, results: [{ title: '第一条' }] })
    expect(values.submitted).toEqual({ submitted: true })
    expect(values.clicked).toEqual({ clicked: true, screenshot: 'screenshots/shot.png' })
    expect(values.tableRows).toEqual({ headers: ['区域', '金额'], rows: [['华北', '1200']] })
    expect(values.collected).toEqual({ pages: 1, items: ['第一条'] })
    expect(values.article).toContain('Example Domain')
    expect(values.downloaded).toEqual({ saved: true, path: 'downloads/report.pdf' })
    // 两处 fill 落在按标签找到的字段上，搜索按了回车。
    const filled = harness.calls.filter((call) => call.method === 'performTargetAction').map((call) => call.args[0] as { action: string; target: { css: string } })
    expect(filled.filter((entry) => entry.action === 'fill').map((entry) => entry.target.css)).toEqual(['input[name=q]', 'input[name=email]', 'input[name=name]'])
    expect(harness.methods()).toContain('pressKey')
  }, 180_000)

  test('velar:devtools：每个函数照写法跑通', async () => {
    const harness = createHarness()
    const outcome = await runModelProgram(browserSpace(harness), `${VelarDevtoolsModule.template}
export const errors = await consoleErrors()
export const failures = await failedRequests()
export const load = await measureLoad()
export const dark = await mobileDark()
export const mocked = await mockApi()
export const stored = await peekStorage()
export const recorded = await record()
export const script = await hidePopup()
`, 120_000)
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.errors).toEqual([{ level: 'error', message: 'TypeError: boom', url: 'https://example.com/' }])
    expect(values.failures).toEqual({ failures: 1, first: { status: 500, body: '{"error":"boom"}' } })
    expect(values.load).toEqual({ metrics: 'NAVIGATION_0: LCP 258 ms, CLS 0.00', lcp: 'LCP 分解：TTFB 40 ms' })
    expect(values.dark).toContain('视口与配色已设好')
    expect(values.mocked).toContain('500')
    expect(values.stored).toEqual({ local: ['token'], cookies: ['sid'] })
    expect(values.recorded).toEqual({ path: 'artifacts/recordings/checkout-flow.gif', frames: 12 })
    expect(values.script).toEqual({ id: 'script-1', enabled: false })
    expect(harness.methods()).toEqual(expect.arrayContaining(['setViewport', 'configureEmulation', 'configureNetwork', 'startScreencast', 'stopScreencast', 'manageUserScripts']))
  }, 180_000)
})
