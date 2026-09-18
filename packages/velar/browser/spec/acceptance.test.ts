/**
 * 浏览器单元的验收测试：每一条对应 spec/invariants.md 里的一个编号，只测对外承诺的行为。
 * 宿主那一侧的纯策略、站点工作区与登录墙经根入口与 `./renderer` 入口测；两件模型面经真的能力端口与代码面会话测，
 * 空间端口是 spec/support.ts 里的替身。实现细节的测试在 test/ 目录。
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  BrowserActionLimits,
  browserActionPolicy,
  BrowserCaptureLimits,
  BrowserConditionLimits,
  BrowserDiagnosticsLimits,
  BrowserErrorCodes,
  BrowserEvaluateLimits,
  BrowserExtractLimits,
  BrowserFetchLimits,
  BrowserInspectLimits,
  type BrowserLoginDetection,
  BrowserPageDataLimits,
  BrowserPendingEventLimits,
  BrowserPerformanceLimits,
  type BrowserSiteContext,
  type BrowserSpacePort,
  type BrowserUserScriptAccess,
  BrowserUserScriptLimits,
  createBrowserLoginGate,
  createBrowserUserScriptStore,
  createBrowserWorkspaceFileAccess,
  VelarBrowserModule,
  VelarDevtoolsModule,
} from '../index.js'
import { browserAddress, browserPreferences } from '../renderer.js'

import {
  BrowserDeclarations,
  browserSpace,
  checkModelProgram,
  createHarness,
  DevtoolsDeclarations,
  failureOf,
  runModelProgram,
} from './support.js'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'browser-acceptance-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 当前站点上下文：工作区根就是这一次用例的临时目录。 */
function siteContext(): BrowserSiteContext {
  return { url: 'https://example.com/page', workspaceRoot: root }
}

describe('浏览器单元的对外承诺', () => {
  test('INV-5 地址栏判据只有一份', () => {
    expect(browserAddress.resolveNavigationInput('example.com/docs')).toBe('https://example.com/docs')
    expect(browserAddress.resolveNavigationInput('怎么写 zod schema')).toBeUndefined()
    expect(browserAddress.resolveSearchOrNavigationInput('怎么写 zod schema')).toContain('https://www.google.com/search')
    expect(browserAddress.resolveSearchOrNavigationInput('怎么写 zod schema', 'bing')).toContain('https://www.bing.com/search')
    expect(browserAddress.siteHost('www.example.co.uk')).toBe('example.co.uk')
    expect(browserAddress.isLocalUrl(new URL('http://localhost:3000/'))).toBe(true)
  })

  test('INV-6 偏好永远落在闭集里', () => {
    expect(browserPreferences.resolveSearchEngineId('bing')).toBe('bing')
    expect(browserPreferences.resolveSearchEngineId('duckduckgo')).toBe('google')
    expect(browserPreferences.resolveSearchEngineId(undefined)).toBe('google')
    expect(browserPreferences.resolveAutomationMode('external')).toBe('external')
    expect(browserPreferences.resolveAutomationMode('随便写的')).toBe('webview')
  })

  test('INV-7 动作策略按词表判定，没有策略表就是放行', () => {
    expect(browserActionPolicy.check(undefined, { action: 'mouse.click' }).kind).toBe('allow')
    const denied = browserActionPolicy.check({ deny: ['network.configure'] }, { action: 'network.configure' })
    expect(denied.kind).toBe('deny')
    expect(denied.matchedAction).toBe('network.configure')
    expect(browserActionPolicy.check({ deny: ['network.configure'] }, { action: 'mouse.click' }).kind).toBe('allow')
  })

  test('INV-8 站点工作区是硬边界', async () => {
    const access = createBrowserWorkspaceFileAccess(root)
    await access.writeFile('notes/hello.txt', '你好', { overwrite: true })
    const read = await access.readFile('notes/hello.txt')
    expect(read.content).toContain('你好')
    await expect(access.readFile('../outside.txt')).rejects.toThrow()
    await expect(access.writeFile('/etc/passwd', 'x', { overwrite: true })).rejects.toThrow()
  })

  test('INV-10 用户脚本的命中规则只有一份，程序建的一律先停用', async () => {
    const access = createBrowserWorkspaceFileAccess(root)
    const store = createBrowserUserScriptStore({
      readFile: (path, startLine, endLine, maxChars) => access.readFile(path, startLine, endLine, maxChars),
      writeFile: (path, content, options) => access.writeFile(path, content, options),
      listFiles: (options) => access.listFiles(options),
    } as unknown as BrowserUserScriptAccess)
    const created = await store.createScript(
      siteContext(),
      { name: '只在文档页跑', code: 'console.info(1)', match: ['https://example.com/docs/*'], excludeMatch: ['https://example.com/docs/private/*'] },
      { source: 'agent', enabled: false }
    )
    expect(created.script.enabled).toBe(false)
    expect(store.matchesUrl(created.script, 'https://example.com/docs/intro')).toBe(true)
    expect(store.matchesUrl(created.script, 'https://example.com/docs/private/x')).toBe(false)
    expect(store.matchesUrl(created.script, 'https://other.com/docs/intro')).toBe(false)

    // 模型面上建的脚本同样先停用：createUserScript 交给端口的 enabled 恒为 false。
    const harness = createHarness()
    await browserSpace(harness).call('devtools', 'createUserScript', { name: '试试', code: 'console.info(1)', match: ['https://example.com/*'] })
    const request = harness.calls.find((call) => call.method === 'manageUserScripts')!.args[0] as { script: { enabled: boolean } }
    expect(request.script.enabled).toBe(false)
  })

  test('INV-11 登录墙每个站点每会话最多问一次', async () => {
    let asked = 0
    const detection = { requiresLogin: true, confidence: 0.9, reason: '页面停在登录页。', signals: ['login-form'] } as BrowserLoginDetection
    const gate = createBrowserLoginGate({
      requestLoginCompletion: async () => {
        asked += 1
        return { approved: false, message: '用户拒绝登录。' }
      },
    })
    const port = { inspectPage: async () => ({ url: 'https://example.com/login', text: '登录', login: detection }) } as unknown as BrowserSpacePort

    expect(gate.shouldPrompt('https://example.com', detection)).toBe(true)
    await gate.wrap(port).inspectPage({})
    expect(asked).toBe(1)
    // 问过就记账：第二次不再阻塞，防的是「用户点了继续但页面仍判定为登录墙」的死锁。
    expect(gate.shouldPrompt('https://example.com', detection)).toBe(false)
    await gate.wrap(port).inspectPage({})
    expect(asked).toBe(1)
    expect(gate.shouldPrompt('https://other.com', detection)).toBe(true)
  })

  test('INV-17 模型面是 velar:browser 与 velar:devtools：声明从源码生成，模型的程序照它调到真实操作', async () => {
    expect(VelarBrowserModule.specifier).toBe('velar:browser')
    expect(VelarDevtoolsModule.specifier).toBe('velar:devtools')
    expect(VelarBrowserModule.declarations).toBe(BrowserDeclarations)
    expect(VelarDevtoolsModule.declarations).toBe(DevtoolsDeclarations)
    expect(VelarBrowserModule.methods).toContain('open')
    expect(VelarBrowserModule.methods).toContain('click')
    expect(VelarDevtoolsModule.methods).toContain('diagnostics')
    for (const declarations of [BrowserDeclarations, DevtoolsDeclarations]) {
      for (const hidden of ['BrowserOperationContext', 'BrowserSpacePort', 'browser:', 'recipe', 'Recipe', 'enterSite']) {
        expect(declarations).not.toContain(hidden)
      }
    }

    const harness = createHarness({ open: false })
    const result = await runModelProgram(browserSpace(harness), `import { open, inspect, click } from 'velar:browser'
import { diagnostics } from 'velar:devtools'
const site = await open({ url: 'https://example.com' })
const page = await inspect({})
const action = page.actions.find((candidate) => candidate.target)
const clicked = action?.target ? await click({ target: action.target }) : null
const errors = await diagnostics({ kind: 'console', errorsOnly: true })
export const root = site.site.workspaceRoot
export const title = page.title
export const matched = clicked?.matched
export const errorCount = errors.entries.length
`)
    expect(result.failed).toBeUndefined()
    expect(result.value).toMatchObject({ title: 'Example Domain', matched: true, errorCount: 1 })
    expect(harness.methods()).toEqual(expect.arrayContaining(['enterSite', 'inspectPage', 'performTargetAction', 'getPageDiagnostics']))
  }, 120_000)

  test('INV-18 声明里写给模型的数字就是常量表里的', () => {
    const browser = [
      `url 最多 ${BrowserActionLimits.urlChars} 个字符`,
      `CSS selector（最多 ${BrowserInspectLimits.selectorChars} 个字符）`,
      `正文最多交回多少字符（最多 ${BrowserInspectLimits.textChars}）`,
      `maxHtmlChars 最多 ${BrowserInspectLimits.htmlChars}`,
      `可交互元素最多几个（最多 ${BrowserInspectLimits.elements}）`,
      `最多 ${BrowserInspectLimits.ignoreSelectors} 个 selector`,
      `最多 ${BrowserInspectLimits.queryAttributes} 个，每个最多 ${BrowserInspectLimits.attributeNameChars} 个字符`,
      `limit 最多几个元素（最多 ${BrowserInspectLimits.queryElements}）`,
      `（最多 ${BrowserInspectLimits.queryTextChars}、${BrowserInspectLimits.queryHtmlChars}）`,
      `最多 ${BrowserCaptureLimits.pathChars} 个字符`,
      `单边最多 ${BrowserCaptureLimits.fullPageMaxSide} 像素`,
      `最多 ${BrowserCaptureLimits.annotatedElements} 个`,
      `宽 ${BrowserCaptureLimits.minViewportWidth} 到 ${BrowserCaptureLimits.maxViewportWidth}，高 ${BrowserCaptureLimits.minViewportHeight} 到 ${BrowserCaptureLimits.maxViewportHeight}`,
      `${BrowserCaptureLimits.minNetworkIdleMs} 到 ${BrowserCaptureLimits.maxNetworkIdleMs}`,
      `含滚动，最多 ${BrowserCaptureLimits.regionMaxSide}`,
      `script 最多 ${BrowserEvaluateLimits.scriptChars} 个字符`,
      `timeoutMs 最多 ${BrowserEvaluateLimits.timeoutMs}`,
      `超过 ${BrowserEvaluateLimits.resultChars} 个字符`,
      `limit 最多几条（最多 ${BrowserPageDataLimits.mediaSources}`,
      `value 最多 ${BrowserActionLimits.textChars} 个字符`,
      `最多 ${BrowserActionLimits.selectValues} 个，每个最多 ${BrowserActionLimits.selectValueChars} 个字符`,
      `一次滚多少像素（最多 ${BrowserActionLimits.scrollAmount}）`,
      `绝对值最多 ${BrowserActionLimits.coordinate}`,
      `（最多 ${BrowserActionLimits.keyChars} 个字符）`,
      `连按几次（最多 ${BrowserActionLimits.keyRepeat}）`,
      `0 到 ${BrowserActionLimits.coordinate}`,
      `连击几下（最多 ${BrowserActionLimits.clickCount}）`,
      `拆成几步移动（最多 ${BrowserActionLimits.dragSteps}）`,
      `最多 ${BrowserFetchLimits.pathChars} 个字符`,
      `timeoutMs 最多 ${BrowserActionLimits.waitMs}`,
      `text 最多 ${BrowserActionLimits.waitExpressionChars} 个字符`,
      `ms 最多 ${BrowserActionLimits.waitMs}`,
      `缺省 ${BrowserPendingEventLimits.defaultWaitMs}、最多 ${BrowserPendingEventLimits.maxWaitMs}`,
      `最多 ${BrowserExtractLimits.tableIndex}，缺省 ${BrowserExtractLimits.defaultTableIndex}`,
      `最多几行（最多 ${BrowserExtractLimits.tableRows}`,
      `最多几条（最多 ${BrowserExtractLimits.listItems}`,
      `maxPages 缺省 ${BrowserExtractLimits.defaultPaginatePages}、最多 ${BrowserExtractLimits.paginatePages}`,
      `每页最多几条（最多 ${BrowserExtractLimits.paginateItemsPerPage}）`,
      `maxChars 最多 ${BrowserExtractLimits.contentChars}`,
      `单个文件最多 ${BrowserFetchLimits.fileBytes} 字节`,
    ]
    for (const text of browser) expect(BrowserDeclarations).toContain(text)

    const devtools = [
      `过滤之后最多几条（最多 ${BrowserDiagnosticsLimits.entries}`,
      `status（100 到 ${BrowserDiagnosticsLimits.networkStatus}）`,
      `resourceType（最多 ${BrowserDiagnosticsLimits.resourceTypeChars} 个字符）`,
      `网络条目（最多 ${BrowserDiagnosticsLimits.requestIdChars} 个字符）`,
      `maxBodyChars 最多 ${BrowserDiagnosticsLimits.responseBodyChars}`,
      `每类最多几项（最多 ${BrowserPageDataLimits.storageItems}）`,
      `每个值最多多少字符（最多 ${BrowserPageDataLimits.storageValueChars}）`,
      `宽 ${BrowserCaptureLimits.minViewportWidth} 到 ${BrowserCaptureLimits.maxViewportWidth}，高 ${BrowserCaptureLimits.minViewportHeight} 到 ${BrowserCaptureLimits.maxViewportHeight}`,
      `zoomFactor（${BrowserConditionLimits.minZoomFactor} 到 ${BrowserConditionLimits.maxZoomFactor}）`,
      `step 是 ${BrowserConditionLimits.minZoomStep} 到 ${BrowserConditionLimits.maxZoomStep}`,
      `名最多 ${BrowserConditionLimits.headerNameChars}、值最多 ${BrowserConditionLimits.headerValueChars} 个字符`,
      `最多 ${BrowserConditionLimits.blockedUrlPatterns} 条，每条最多 ${BrowserConditionLimits.urlPatternChars} 个字符`,
      `最多 ${BrowserConditionLimits.blockedResourceTypes} 种`,
      `最多 ${BrowserConditionLimits.mockResponses} 条，正文最多 ${BrowserConditionLimits.mockBodyChars} 个字符`,
      `时区（最多 ${BrowserConditionLimits.timezoneChars} 个字符）`,
      `语言（最多 ${BrowserConditionLimits.localeChars} 个字符）`,
      `降速几倍（1 到 ${BrowserConditionLimits.maxCpuThrottlingRate}）`,
      `缺省 ${BrowserPerformanceLimits.defaultTraceMs}，${BrowserPerformanceLimits.minTraceMs} 到 ${BrowserPerformanceLimits.maxTraceMs}`,
      `各最多 ${BrowserPerformanceLimits.insightIdChars} 个字符`,
      `最多 ${BrowserPerformanceLimits.snapshotPathChars} 个字符`,
      `${BrowserCaptureLimits.minScreencastWidth} 到 ${BrowserCaptureLimits.maxScreencastWidth}，缺省 ${BrowserCaptureLimits.defaultScreencastWidth}`,
      `1 到 ${BrowserCaptureLimits.maxScreencastFrameStep}，缺省 ${BrowserCaptureLimits.defaultScreencastFrameStep}`,
      `产物名（最多 ${BrowserCaptureLimits.screencastNameChars} 个字符）`,
      `name 最多 ${BrowserUserScriptLimits.nameChars} 个字符，code 最多 ${BrowserUserScriptLimits.codeBytes} 字节`,
      `各最多 ${BrowserUserScriptLimits.matchRules} 条、每条最多 ${BrowserUserScriptLimits.matchRuleChars} 个字符`,
    ]
    for (const text of devtools) expect(DevtoolsDeclarations).toContain(text)
  })

  test('INV-19 代码模版照真实声明过类型检查，不嵌进声明，随模型面发布', () => {
    for (const module of [VelarBrowserModule, VelarDevtoolsModule]) {
      expect(module.template.length).toBeGreaterThan(0)
      expect(module.declarations).not.toContain(module.template.split('\n')[0]!)
      expect(checkModelProgram(module.template)).toEqual([])
      // import 只写一次。
      expect(module.template.match(/^import /gmu)?.length).toBe(1)
    }
    // 每个函数照写法跑通由 test/template.test.ts 核对。
    expect(existsSync(new URL('../test/template.test.ts', import.meta.url))).toBe(true)
  })

  test('INV-20 没进站点时要页面的操作抛 BROWSER_SITE_NOT_OPEN，端口上碰页面的方法一次都不调', async () => {
    const harness = createHarness({ open: false })
    const space = browserSpace(harness)
    for (const [namespace, operation, input] of [
      ['browser', 'inspect', {}],
      ['browser', 'click', { target: '#go' }],
      ['browser', 'back', undefined],
      ['browser', 'screenshot', {}],
      ['devtools', 'diagnostics', {}],
      ['devtools', 'userScripts', undefined],
    ] as const) {
      const failure = await failureOf(space.call(namespace, operation, input))
      expect(failure.code).toBe(BrowserErrorCodes.siteNotOpen)
      expect(failure.message).toContain('open')
    }
    expect(harness.calls).toEqual([])
    expect(await space.call('browser', 'state')).toEqual({ active: false })
  })

  test('INV-21 入参在做事之前核对，不合法一步都不做', async () => {
    const harness = createHarness()
    const space = browserSpace(harness)
    const extra = await failureOf(space.call('browser', 'inspect', { cwd: '/tmp' }))
    expect(extra.code).toBe('VALIDATION')
    expect(extra.message).toContain('inspect')
    const tooLong = await failureOf(space.call('browser', 'goto', { url: `https://example.com/${'x'.repeat(BrowserActionLimits.urlChars)}` }))
    expect(tooLong.code).toBe('VALIDATION')
    expect(tooLong.message).toContain('url')
    expect((await failureOf(space.call('browser', 'click', { target: {} }))).code).toBe('VALIDATION')
    expect((await failureOf(space.call('browser', 'handleDownload', {}))).code).toBe('VALIDATION')
    expect((await failureOf(space.call('devtools', 'zoom', { action: 'set' }))).code).toBe('VALIDATION')
    expect((await failureOf(space.call('devtools', 'network', {}))).code).toBe('VALIDATION')
    expect((await failureOf(space.call('devtools', 'updateUserScript', { id: 'script-1' }))).code).toBe('VALIDATION')
    expect(harness.calls).toEqual([])
  })

  test('INV-22 截图的图经交图通道交给模型，不进返回值', async () => {
    const harness = createHarness()
    const shot = await browserSpace(harness).call('browser', 'screenshot', { annotate: true })
    expect(harness.attached).toHaveLength(1)
    expect(harness.attached[0]!.mediaType).toBe('image/jpeg')
    expect(JSON.stringify(shot)).not.toContain('aW1hZ2U=')
    expect(shot).toMatchObject({ relativePath: 'screenshots/shot.png', image: { width: 640, height: 400, scale: 0.5 } })
    expect(shot.legend[0].target.css).toBe('button.login')

    // 没有交图通道时照样截图落盘，只是不要压缩图。
    const blind = createHarness({ attach: false })
    const blindShot = await browserSpace(blind).call('browser', 'screenshot', {})
    expect(blind.attached).toEqual([])
    expect(blindShot.relativePath).toBe('screenshots/shot.png')
    expect(blindShot.image).toBeUndefined()
  })

  test('INV-23 不替模型折叠：没给上限时按常量表的上限向端口要', async () => {
    const harness = createHarness()
    const space = browserSpace(harness)
    await space.call('browser', 'inspect', {})
    await space.call('browser', 'query', { selector: 'a' })
    await space.call('browser', 'media', {})
    await space.call('browser', 'evaluate', { script: 'document.title' })
    await space.call('devtools', 'diagnostics', {})
    await space.call('devtools', 'storage', {})
    await space.call('devtools', 'request', { requestId: 'req-1', includeResponseBody: true })
    const argsOf = (method: string) => harness.calls.find((call) => call.method === method)!.args[0] as Record<string, unknown>
    expect(argsOf('inspectPage')).toMatchObject({ maxTextChars: BrowserInspectLimits.textChars, maxHtmlChars: BrowserInspectLimits.htmlChars, maxElements: BrowserInspectLimits.elements })
    expect(argsOf('queryElements')).toMatchObject({ limit: BrowserInspectLimits.queryElements, maxTextChars: BrowserInspectLimits.queryTextChars })
    expect(argsOf('listMediaSources')).toMatchObject({ limit: BrowserPageDataLimits.mediaSources })
    expect(argsOf('evaluateScript')).toMatchObject({ maxResultChars: BrowserEvaluateLimits.resultChars })
    expect(argsOf('getPageDiagnostics')).toMatchObject({ limit: BrowserDiagnosticsLimits.entries })
    expect(argsOf('readPageStorage')).toMatchObject({ limit: BrowserPageDataLimits.storageItems, maxValueChars: BrowserPageDataLimits.storageValueChars })
    expect(argsOf('readNetworkRequestDetails')).toMatchObject({ maxBodyChars: BrowserDiagnosticsLimits.responseBodyChars })

    // 取内容走页面提取脚本：上限写进脚本的载荷里。
    await space.call('browser', 'table', {})
    await space.call('browser', 'content', {})
    const scripts = harness.calls.filter((call) => call.method === 'evaluateScript').map((call) => (call.args[0] as { script: string }).script)
    expect(scripts.some((script) => script.includes(`"maxRows":${BrowserExtractLimits.tableRows}`))).toBe(true)
    expect(scripts.some((script) => script.includes(`"maxChars":${BrowserExtractLimits.contentChars}`))).toBe(true)
  })
})
