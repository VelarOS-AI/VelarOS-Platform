/**
 * 浏览器能力的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，只经四个入口（`../src/index` 与 `../src/renderer`）；
 * 实现细节的测试在 test/ 目录。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  browserActionPolicy,
  type BrowserLoginDetection,
  browserRecipes,
  BrowserResidentToolNames,
  type BrowserSiteContext,
  browserTools,
  type BrowserUserScriptAccess,
  type BrowserWorkspaceArtifactAccess,
  BrowserWorkspaceArtifactDirectoryMap,
  createBrowserBundledModDefinition,
  createBrowserLoginGate,
  createBrowserUserScriptStore,
  createBrowserWorkspaceArtifacts,
  createBrowserWorkspaceFileAccess,
  type ToolBrowserApi,
} from '../src/index'
import { browserAddress, browserPreferences } from '../src/renderer'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'browser-acceptance-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 当前站点上下文：工作区根就是这一次用例的临时目录。 */
function siteContext(): BrowserSiteContext {
  return { url: 'https://example.com/page', workspaceRoot: root } as BrowserSiteContext
}

describe('浏览器包的对外承诺', () => {
  test('INV-1 常驻集是主回路，enter_site 一定在里面', () => {
    expect(BrowserResidentToolNames).toContain('browser:enter_site')
    for (const name of BrowserResidentToolNames) {
      expect(Object.keys(browserTools)).toContain(name)
    }
  })

  test('INV-2 每个工具恰好属于一个职责类别，并集等于工具全集', () => {
    const definition = createBrowserBundledModDefinition()
    const contributions = (definition.manifest as {
      contributes: { tools: Array<{ name: string; categoryId: string }> }
    }).contributes.tools
    const names = contributions.map((tool) => tool.name)

    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual(Object.keys(browserTools).sort())
    for (const tool of contributions) expect(tool.categoryId).toMatch(/^browser-/u)
  })

  test('INV-3 客居空间由宿主传，不传就只挂浏览器空间', () => {
    const contributions = (name: readonly string[] | undefined) =>
      (createBrowserBundledModDefinition(
        name ? { guestSpaceIds: name } : {}
      ).manifest as {
        contributes: { tools: Array<{ availableInSpaces: string[] }> }
      }).contributes.tools

    for (const tool of contributions(undefined)) {
      expect(tool.availableInSpaces).toEqual(['browser'])
    }
    for (const tool of contributions(['project'])) {
      expect(tool.availableInSpaces).toEqual(['browser', 'project'])
    }
  })

  test('INV-4 客居是可用不常驻：residentInSpaces 只写浏览器空间', () => {
    const contributions = (createBrowserBundledModDefinition({ guestSpaceIds: ['project'] }).manifest as {
      contributes: { tools: Array<{ name: string; residentInSpaces?: string[] }> }
    }).contributes.tools

    for (const tool of contributions) {
      expect(tool.residentInSpaces ?? null).toEqual(
        BrowserResidentToolNames.includes(tool.name as never) ? ['browser'] : null
      )
    }
  })

  test('INV-5 地址栏判据只有一份', () => {
    expect(browserAddress.resolveNavigationInput('example.com/docs')).toBe('https://example.com/docs')
    expect(browserAddress.resolveNavigationInput('怎么写 zod schema')).toBeUndefined()
    expect(browserAddress.resolveSearchOrNavigationInput('怎么写 zod schema')).toContain(
      'https://www.google.com/search'
    )
    expect(browserAddress.resolveSearchOrNavigationInput('怎么写 zod schema', 'bing')).toContain(
      'https://www.bing.com/search'
    )
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

    const denied = browserActionPolicy.check(
      { deny: ['network.configure'] },
      { action: 'network.configure' }
    )
    expect(denied.kind).toBe('deny')
    expect(denied.matchedAction).toBe('network.configure')
    expect(browserActionPolicy.check({ deny: ['network.configure'] }, { action: 'mouse.click' }).kind)
      .toBe('allow')
  })

  test('INV-8 站点工作区是硬边界', async () => {
    const access = createBrowserWorkspaceFileAccess(root)
    await access.writeFile('notes/hello.txt', '你好', { overwrite: true })
    const read = await access.readFile('notes/hello.txt')
    expect(read.content).toContain('你好')

    await expect(access.readFile('../outside.txt')).rejects.toThrow()
    await expect(access.writeFile('/etc/passwd', 'x', { overwrite: true })).rejects.toThrow()
  })

  test('INV-9 产物按类别落在固定目录，命名规则只有一份', async () => {
    const access = createBrowserWorkspaceFileAccess(root)
    const artifacts = createBrowserWorkspaceArtifacts({
      readFile: (path, startLine, endLine, maxChars) =>
        access.readFile(path, startLine, endLine, maxChars),
      writeFile: (path, content, options) => access.writeFile(path, content, options),
      listFiles: (options) => access.listFiles(options),
    } as unknown as BrowserWorkspaceArtifactAccess)

    const record = await artifacts.writeArtifact({
      context: siteContext(),
      kind: 'extract',
      format: 'json',
      name: '价格表',
      content: '{"rows":[]}',
    })
    expect(record.relativePath.startsWith(`${BrowserWorkspaceArtifactDirectoryMap.extract}/`)).toBe(true)
    expect(record.relativePath.endsWith('.json')).toBe(true)
    expect(await readFile(join(root, record.relativePath), 'utf8')).toContain('rows')
  })

  test('INV-10 用户脚本的命中规则只有一份', async () => {
    const access = createBrowserWorkspaceFileAccess(root)
    const store = createBrowserUserScriptStore({
      readFile: (path, startLine, endLine, maxChars) =>
        access.readFile(path, startLine, endLine, maxChars),
      writeFile: (path, content, options) => access.writeFile(path, content, options),
      listFiles: (options) => access.listFiles(options),
    } as unknown as BrowserUserScriptAccess)

    const context = siteContext()
    const created = await store.createScript(
      context,
      {
        name: '只在文档页跑',
        code: 'console.info(1)',
        match: ['https://example.com/docs/*'],
        excludeMatch: ['https://example.com/docs/private/*'],
      },
      { source: 'agent', enabled: false }
    )

    // agent 建的脚本由宿主决定初始状态；这里按「先停用、等用户确认」的产品口径建。
    expect(created.script.enabled).toBe(false)
    expect(store.matchesUrl(created.script, 'https://example.com/docs/intro')).toBe(true)
    expect(store.matchesUrl(created.script, 'https://example.com/docs/private/x')).toBe(false)
    expect(store.matchesUrl(created.script, 'https://other.com/docs/intro')).toBe(false)
  })

  test('INV-11 登录墙每个站点每会话最多问一次', async () => {
    let asked = 0
    const detection: BrowserLoginDetection = {
      requiresLogin: true,
      confidence: 0.9,
      reason: '页面停在登录页。',
      signals: ['login-form'],
    }
    const gate = createBrowserLoginGate({
      requestLoginCompletion: async () => {
        asked += 1
        return { approved: false, message: '用户拒绝登录。' }
      },
    })
    const api = {
      inspectPage: async () => ({ url: 'https://example.com/login', text: '登录', login: detection }),
    } as unknown as ToolBrowserApi

    expect(gate.shouldPrompt('https://example.com', detection)).toBe(true)
    await gate.wrap(api).inspectPage({})
    expect(asked).toBe(1)
    // 问过就记账：第二次不再阻塞，防的是「用户点了继续但页面仍判定为登录墙」的死锁。
    expect(gate.shouldPrompt('https://example.com', detection)).toBe(false)
    await gate.wrap(api).inspectPage({})
    expect(asked).toBe(1)
    // 另一个站点单独记账。
    expect(gate.shouldPrompt('https://other.com', detection)).toBe(true)
  })

  test('INV-12 recipe 产物与当前站点同源', () => {
    const skeleton = JSON.stringify({
      version: 1,
      url: 'https://example.com/login',
      title: '登录',
      summary: '登录流程',
      inputs: [],
      suggestedSteps: [],
      generatedAt: 1,
    })

    expect(browserRecipes.normalizePath('recipes/flow.json')).toBe('recipes/flow.json')
    expect(browserRecipes.preview('recipes/flow.json', skeleton, 'https://example.com/home').title).toBe('登录')
    expect(() => browserRecipes.preview('recipes/flow.json', skeleton, 'https://other.com/home')).toThrow()
  })
})
