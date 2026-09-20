/**
 * 代码模版是给模型看的日常用法示例：只过类型检查不够，结果取错一个键、写法跑不通，模型照着写就跟着错。
 * 这里把三份模版的每个函数经真的代码面会话调一遍——和模型交程序是同一条路；空间端口是 spec/support.ts 的替身，
 * 按一页固定的假页面回答（表单、表格、框架、诊断、下载事件、模型 CDP 会话的事件……）。
 */
import { describe, expect, test } from 'bun:test'

import { VelarBrowserModule, VelarCdpModule, VelarDevtoolsModule } from '../index.js'
import { browserSpace, createHarness, runModelProgram } from '../spec/support.js'

describe('代码模版', () => {
  test('velaros:browser：每个函数照写法跑通', async () => {
    const harness = createHarness({ open: false })
    const outcome = await runModelProgram(browserSpace(harness), `${VelarBrowserModule.template}
export const looked = await look()
export const rows = await readRows()
export const searched = await search()
export const submitted = await submitForm()
export const collected = await collectPages()
export const clicked = await clickByLook()
export const dragged = await dragHandle()
export const selected = await shiftSelect()
export const framed = await readFrame()
export const downloaded = await saveDownload()
`, 120_000)
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.looked).toMatchObject({ title: 'Example Domain', headings: ['Example Domain'] })
    expect(values.looked.actions[0].target.css).toBe('button.login')
    expect(values.rows).toEqual([['华北', '1200']])
    expect(values.searched).toEqual([{ title: '第一条', href: 'https://example.com/1' }])
    expect(values.submitted).toBe(true)
    expect(values.collected).toEqual([{ title: '第一条', href: 'https://example.com/1' }])
    expect(values.clicked).toEqual({ clicked: true, screenshot: 'screenshots/shot.png' })
    expect(values.dragged).toEqual({ url: 'https://example.com/', x: 300, y: 200, buttons: [] })
    expect(values.selected).toEqual({ url: 'https://example.com/', key: 'Shift', held: [] })
    expect(values.framed).toBe('iframe 里的正文')
    expect(values.downloaded).toEqual({ saved: true, path: 'downloads/report.pdf' })

    // fill 走真实输入：页面里全选、宿主插入文字、再读一次控件状态；下拉框的值经 args 传进页面脚本，没有拼进源码。
    const actions = harness.calls.filter((call) => call.method === 'performTargetAction').map((call) => (call.args[0] as { action: string }).action)
    expect(actions).toEqual(expect.arrayContaining(['select_all', 'focus', 'click']))
    expect(harness.calls.filter((call) => call.method === 'insertText').map((call) => (call.args[0] as { text: string }).text)).toEqual(['velaros', 'user@example.com'])
    const selectScript = harness.calls.find((call) => call.method === 'evaluateScript' && (call.args[0] as { script: string }).script.includes('select[name=country]'))
    expect((selectScript!.args[0] as { args: unknown[] }).args).toEqual(['CN'])
    expect(harness.methods()).toEqual(expect.arrayContaining(['pressKey', 'keyDown', 'keyUp', 'mouseDown', 'mouseUp', 'listFrames']))
  }, 180_000)

  test('velaros:devtools：每个函数照写法跑通', async () => {
    const harness = createHarness()
    const outcome = await runModelProgram(browserSpace(harness), `${VelarDevtoolsModule.template}
export const errors = await consoleErrors()
export const failures = await failedRequests()
export const load = await measureLoad()
export const mocked = await mockApi()
export const recorded = await record()
export const script = await hidePopup()
`, 120_000)
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.errors).toEqual([{ level: 'error', message: 'TypeError: boom', url: 'https://example.com/' }])
    expect(values.failures).toEqual({ failures: 1, first: { status: 500, body: '{"error":"boom"}' } })
    expect(values.load).toEqual({ metrics: 'NAVIGATION_0: LCP 258 ms, CLS 0.00', lcp: 'LCP 分解：TTFB 40 ms' })
    expect(values.mocked).toContain('500')
    expect(values.recorded).toEqual({ path: 'artifacts/recordings/checkout-flow.gif', frames: 12 })
    expect(values.script).toEqual({ id: 'script-1', enabled: false })
    expect(harness.methods()).toEqual(expect.arrayContaining(['configureNetwork', 'startScreencast', 'stopScreencast', 'manageUserScripts']))
  }, 180_000)

  test('velaros:cdp：每个函数照写法跑通', async () => {
    const harness = createHarness()
    const outcome = await runModelProgram(browserSpace(harness), `${VelarCdpModule.template}
export const dark = await mobileDark()
export const cookies = await cookieNames()
export const requests = await requestsDuring()
export const faked = await fakeResponse()
export const injected = await beforePageScripts()
export const undone = await undoAll()
`, 120_000)
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.dark).toBe('手机尺寸与深色已设好')
    expect(values.cookies).toEqual([{ name: 'sid', domain: 'example.com', httpOnly: true }])
    expect(values.requests).toEqual([{ method: 'GET', url: 'https://example.com/api/more' }])
    expect(values.faked).toBe('https://example.com/api/profile')
    expect(values.injected).toBe('script-1')
    expect(values.undone).toContain('会话已断开')
    const sent = harness.calls.filter((call) => call.method === 'sendProtocolCommand').map((call) => (call.args[0] as { method: string }).method)
    expect(sent).toEqual(expect.arrayContaining(['Emulation.setDeviceMetricsOverride', 'Network.getCookies', 'Fetch.enable', 'Fetch.fulfillRequest', 'Fetch.disable']))
    expect(harness.methods()).toContain('resetProtocolSession')
  }, 180_000)
})
