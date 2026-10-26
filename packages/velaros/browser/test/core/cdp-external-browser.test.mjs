/**
 * @test-meta
 * title: 外部浏览器一条连接
 * summary: 外部浏览器只走一条浏览器级 WebSocket：标签页会话按 sessionId 分流、子会话跟着页面走、标签页关了或浏览器退了驱动就作废；
 *   启动器先接用户开着的 Chrome、再接 userDataDir 上开着的、都没有才拉起，几次 launch 共用一条连接各开各的标签页，
 *   会话只关自己的标签页，收尾只杀自己拉起的浏览器；运行时据此回答会话还有没有外部页面。
 * area: packages
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { ExternalBrowserUnavailableReason } from '../../../dist/browser/contract/constants.js'
import { createElectronBrowserRuntime } from '../../../dist/browser/electron.js'
import { CdpBrowserConnection } from '../../../dist/browser/impl/cdp/CdpBrowserConnection.js'
import { CdpBrowserPageDriver } from '../../../dist/browser/impl/cdp/CdpBrowserPageDriver.js'
import { CdpExternalBrowserLauncher } from '../../../dist/browser/impl/cdp/CdpExternalBrowserLauncher.js'
import { getDefaultUserDataDirCandidates } from '../../../dist/browser/utils/cdp/launcher.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/** 一条假的 WebSocket：发出去的交给对面的假浏览器，对面回的按 message 事件送回来。 */
class FakeSocket {
  listeners = new Map()
  closed = false
  onSend = () => undefined

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  send(data) {
    if (!this.closed) this.onSend(JSON.parse(data))
  }

  close() {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => this.emit('close'))
  }

  /** 对面（浏览器）断开。 */
  drop() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  deliver(message) {
    if (!this.closed) this.emit('message', { data: JSON.stringify(message) })
  }
}

/** 一个假浏览器：只开浏览器级 WebSocket，Target 域建、挂、关标签页，flatten 会话按 sessionId 回话。 */
class FakeBrowser {
  constructor(port, id) {
    this.url = `ws://127.0.0.1:${port}/devtools/browser/${id}`
    this.running = true
    this.sockets = []
    this.tabs = new Map([['start', { url: 'about:blank', title: '', browserContextId: 'default' }]])
    this.sessions = new Map()
    this.calls = []
    this.downloadBehavior = null
    this.nextId = 1
  }

  accept(socket) {
    this.sockets.push(socket)
    socket.onSend = (message) => queueMicrotask(() => this.handle(socket, message))
    socket.emit('open')
  }

  handle(socket, { id, method, params = {}, sessionId }) {
    this.calls.push({ method, params, sessionId })
    const reply = (result) => socket.deliver(sessionId ? { id, result, sessionId } : { id, result })
    const fail = (message) => socket.deliver({ id, error: { code: -32_000, message } })
    if (method === 'Test.hang') return
    if (sessionId) {
      const session = this.sessions.get(sessionId)
      if (!session) return fail('Session with given id not found.')
      if (method === 'Runtime.evaluate') {
        const tab = this.tabs.get(session.targetId)
        return reply({ result: { type: 'object', value: { url: tab?.url ?? '', title: '' } } })
      }
      return reply({})
    }
    switch (method) {
      case 'Browser.getVersion':
        return reply({ product: 'Chrome/153.0.0.0' })
      case 'Browser.setDownloadBehavior':
        this.downloadBehavior = params
        return reply({})
      case 'Target.getTargets':
        return reply({
          targetInfos: [
            ...[...this.tabs].map(([targetId, tab]) => ({ targetId, type: 'page', ...tab })),
            {
              targetId: 'incognito-tab',
              type: 'page',
              url: 'https://secret.test/',
              title: '',
              browserContextId: 'incognito',
            },
            {
              targetId: 'sw',
              type: 'service_worker',
              url: 'chrome-extension://x/sw.js',
              title: '',
              browserContextId: 'default',
            },
          ],
        })
      case 'Target.createTarget': {
        const targetId = `tab-${this.nextId++}`
        this.tabs.set(targetId, { url: params.url, title: '', browserContextId: 'default' })
        return reply({ targetId })
      }
      case 'Target.attachToTarget': {
        if (!this.tabs.has(params.targetId)) return fail('No target with given id found')
        const attached = `session-${this.nextId++}`
        this.sessions.set(attached, { targetId: params.targetId, socket })
        socket.deliver({
          method: 'Target.attachedToTarget',
          params: { sessionId: attached, targetInfo: { targetId: params.targetId, type: 'page' } },
        })
        return reply({ sessionId: attached })
      }
      case 'Target.detachFromTarget':
        this.detach(params.sessionId)
        return reply({})
      case 'Target.closeTarget':
        this.closeTab(params.targetId)
        return reply({ success: true })
      default:
        return reply({})
    }
  }

  detach(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.socket.deliver({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId: session.targetId },
    })
  }

  /** 标签页关了（用户关的，或者 Target.closeTarget）：挂在上面的会话都脱开。 */
  closeTab(targetId) {
    this.tabs.delete(targetId)
    for (const [sessionId, session] of [...this.sessions])
      if (session.targetId === targetId) this.detach(sessionId)
  }

  /** 页面会话上来一个事件。 */
  event(sessionId, method, params = {}) {
    this.sessions.get(sessionId).socket.deliver({ method, params, sessionId })
  }

  /** 页面会话上挂出一个子会话（跨进程 iframe）。 */
  attachChild(parentSessionId, childSessionId) {
    const parent = this.sessions.get(parentSessionId)
    this.sessions.set(childSessionId, {
      targetId: `frame-${childSessionId}`,
      socket: parent.socket,
    })
    this.event(parentSessionId, 'Target.attachedToTarget', {
      sessionId: childSessionId,
      targetInfo: { type: 'iframe' },
    })
  }

  /** 用户退出了浏览器：连接全断。 */
  quit() {
    this.running = false
    for (const socket of this.sockets) socket.drop()
  }

  commands(method) {
    return this.calls.filter((call) => call.method === method)
  }
}

/** 本机回环网：按地址找浏览器，没有（端口文件过期）就是连接被拒。 */
class FakeNetwork {
  browsers = new Map()
  opened = []

  add(browser) {
    this.browsers.set(browser.url, browser)
    return browser
  }

  createSocket = (url) => {
    this.opened.push(url)
    const socket = new FakeSocket()
    const browser = this.browsers.get(url)
    queueMicrotask(() => {
      if (browser?.running) browser.accept(socket)
      else socket.drop()
    })
    return socket
  }
}

const Home = '/home/tester'
const ChromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const userChromeDir = (channel = 'Chrome') =>
  `${Home}/Library/Application Support/Google/${channel}`

/** 一台假机器：假文件、假网络、假进程；启动器的依赖全换成它们，不碰真的 Chrome 与用户目录。 */
function createMachine() {
  const files = new Map([[ChromeExecutable, '']])
  const reads = []
  const network = new FakeNetwork()
  const spawned = []
  const kills = []
  const removed = []
  const launcher = new CdpExternalBrowserLauncher({
    homedir: () => Home,
    env: {},
    existsSync: (path) => {
      reads.push(path)
      return files.has(path)
    },
    readFile: async (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`)
      return files.get(path)
    },
    unlink: async (path) => {
      files.delete(path)
    },
    mkdtemp: async (prefix) => `${prefix}${spawned.length + 1}`,
    rm: async (path) => {
      removed.push(path)
    },
    sleep: () => settle(),
    processKill: (pid, signal) => {
      kills.push([pid, signal])
      return true
    },
    createSocket: network.createSocket,
    spawn: (command, args) => {
      const index = spawned.length
      const userDataDir = args
        .find((arg) => arg.startsWith('--user-data-dir='))
        .slice('--user-data-dir='.length)
      const port = 40_000 + index
      const browser = network.add(new FakeBrowser(port, `spawned-${index}`))
      const child = {
        pid: 5_000 + index,
        exitCode: null,
        killed: false,
        kill(signal) {
          kills.push(['child', signal])
          this.killed = true
          return true
        },
      }
      spawned.push({ command, args, userDataDir, browser, child })
      // Chrome 起来一会儿之后才写出端口文件。
      setTimeout(
        () =>
          files.set(
            `${userDataDir}/DevToolsActivePort`,
            `${port}\n/devtools/browser/spawned-${index}\n`
          ),
        5
      )
      return child
    },
  })
  /** 用户在 chrome://inspect/#remote-debugging 打开了远程调试的 Chrome。 */
  const runUserChrome = (channel = 'Chrome', port = 9_222) => {
    const browser = network.add(new FakeBrowser(port, `user-${channel}`))
    files.set(
      `${userChromeDir(channel)}/DevToolsActivePort`,
      `${port}\n/devtools/browser/user-${channel}\n`
    )
    return browser
  }
  return { files, reads, network, spawned, kills, removed, launcher, runUserChrome }
}

describe('浏览器级连接上的标签页会话', () => {
  test('每页的事件只进自己的会话，子会话跟着页面转发，发给别人的会话发不过去', async () => {
    const network = new FakeNetwork()
    const browser = network.add(new FakeBrowser(9_222, 'b'))
    const connection = await new CdpBrowserConnection().connect(browser.url, {
      createSocket: network.createSocket,
    })
    const a = await connection.attach(await connection.createPage('https://a.test/'))
    const b = await connection.attach(await connection.createPage('https://b.test/'))
    const seen = { a: [], b: [], anyA: [], anyB: [] }
    a.onEvent('Runtime.consoleAPICalled', (params) => seen.a.push(params.n))
    b.onEvent('Runtime.consoleAPICalled', (params) => seen.b.push(params.n))
    a.onAnyEvent((method, _params, sessionId) => seen.anyA.push([method, sessionId]))
    b.onAnyEvent((method, _params, sessionId) => seen.anyB.push([method, sessionId]))

    browser.event(a.sessionId, 'Runtime.consoleAPICalled', { n: 1 })
    browser.event(b.sessionId, 'Runtime.consoleAPICalled', { n: 2 })
    browser.attachChild(a.sessionId, 'child-a')
    browser.event('child-a', 'Runtime.consoleAPICalled', { n: 3 })
    await settle()

    assert.deepEqual(seen.a, [1], '按方法订阅只收这一页自己的，子会话的同名事件不混进来')
    assert.deepEqual(seen.b, [2])
    assert.deepEqual(seen.anyA, [
      ['Runtime.consoleAPICalled', undefined],
      ['Target.attachedToTarget', undefined],
      ['Runtime.consoleAPICalled', 'child-a'],
    ])
    assert.deepEqual(seen.anyB, [['Runtime.consoleAPICalled', undefined]])

    await a.send('Page.getFrameTree', {}, 'child-a')
    assert.equal(browser.calls.at(-1).sessionId, 'child-a', '明写的子会话照发')
    await a.send('Runtime.enable')
    assert.equal(browser.calls.at(-1).sessionId, a.sessionId, '不写 sessionId 就发给这一页')
    const before = browser.calls.length
    await assert.rejects(a.send('Page.enable', {}, b.sessionId), { code: 'EXECUTION_FAILED' })
    assert.equal(browser.calls.length, before, '别的标签页的会话一条都不发过去')

    connection.dispose()
  })

  test('标签页关了，驱动作废、在飞的命令当场拒绝；别的页不受影响；释放只脱开自己，不关共用的 socket', async () => {
    const network = new FakeNetwork()
    const browser = network.add(new FakeBrowser(9_222, 'b'))
    const connection = await new CdpBrowserConnection().connect(browser.url, {
      createSocket: network.createSocket,
    })
    const tabA = await connection.createPage('https://a.test/')
    const tabB = await connection.createPage('https://b.test/')
    const a = await connection.attach(tabA)
    const driverA = new CdpBrowserPageDriver({ transport: a })
    const driverB = new CdpBrowserPageDriver({ transport: await connection.attach(tabB) })
    await settle()

    const hanging = a.send('Test.hang')
    browser.closeTab(tabA)
    await assert.rejects(hanging, { code: 'EXECUTION_ABORTED' })
    assert.equal(driverA.isDestroyed(), true)
    assert.equal(driverB.isDestroyed(), false)

    driverB.dispose()
    await settle()
    assert.deepEqual(
      browser.commands('Target.detachFromTarget').map((call) => call.sessionId),
      [undefined],
      '脱开发在浏览器级会话上'
    )
    assert.equal(browser.sockets[0].closed, false, '共用的 socket 还开着')
    assert.equal(connection.isClosed(), false)
    connection.dispose()
  })

  test('浏览器退了（连接断了），挂在上面的驱动全部作废，在飞的命令当场拒绝', async () => {
    const network = new FakeNetwork()
    const browser = network.add(new FakeBrowser(9_222, 'b'))
    const connection = await new CdpBrowserConnection().connect(browser.url, {
      createSocket: network.createSocket,
    })
    const session = await connection.attach(await connection.createPage('https://a.test/'))
    const driver = new CdpBrowserPageDriver({ transport: session })
    await settle()
    const hanging = session.send('Test.hang')
    let closed = 0
    connection.onClose(() => {
      closed += 1
    })

    browser.quit()
    await assert.rejects(hanging, { code: 'EXECUTION_ABORTED' })
    assert.equal(driver.isDestroyed(), true)
    assert.equal(connection.isClosed(), true)
    assert.equal(closed, 1)
    await assert.rejects(connection.createPage('about:blank'), { code: 'EXECUTION_ABORTED' })
  })

  test('驱动经标签页目录列页面、切页面、给模型另开会话，全走浏览器级连接', async () => {
    const machine = createMachine()
    const browser = machine.runUserChrome()
    const session = await machine.launcher.launch({ url: 'https://a.test/', platform: 'darwin' })
    const other = await machine.launcher.launch({ url: 'https://b.test/', platform: 'darwin' })

    const targets = await session.driver.listPageTargets()
    assert.deepEqual(
      targets.map((target) => [target.url, target.active]),
      [
        ['about:blank', false],
        ['https://a.test/', true],
        ['https://b.test/', false],
      ],
      '同一个浏览器上下文里的标签页；无痕窗口与非页面的 target 不列'
    )

    const bTab = targets.find((target) => target.url === 'https://b.test/')
    const switched = await session.driver.switchPageTarget({ targetId: bTab.id })
    assert.notEqual(switched, session.driver)
    assert.equal(switched.getURL(), 'https://b.test/')
    assert.deepEqual(
      (await switched.listPageTargets())
        .filter((target) => target.active)
        .map((target) => target.id),
      [bTab.id]
    )
    assert.equal(await session.driver.switchPageTarget({ targetId: targets[1].id }), session.driver)

    const known = new Set(browser.sessions.keys())
    const channel = await session.driver.openProtocolChannel()
    const channelSession = [...browser.sessions.keys()].find((sessionId) => !known.has(sessionId))
    assert.ok(channelSession, '模型的会话是同一页上另挂的一条 flatten 会话')
    const events = []
    channel.onEvent((method, _params, sessionId) => events.push([method, sessionId]))
    await channel.send('Runtime.enable', undefined)
    assert.equal(browser.calls.at(-1).sessionId, channelSession)
    browser.event(channelSession, 'Runtime.executionContextCreated')
    await settle()
    assert.deepEqual(events, [['Runtime.executionContextCreated', undefined]])
    await channel.close()
    await settle()
    assert.equal(browser.sessions.has(channelSession), false, '关掉模型的会话就脱开它')

    assert.equal(machine.network.opened.length, 1, '从头到尾一条 WebSocket')
    assert.equal(browser.commands('Target.getTargets').length > 0, true)
    switched.dispose()
    other.dispose()
    session.dispose()
    machine.launcher.dispose()
  })
})

describe('外部浏览器启动器', () => {
  test('用户自己的 Chrome：按默认配置目录的端口文件接上，过期的端口文件跳过；不改它的下载行为', async () => {
    const machine = createMachine()
    machine.files.set(
      `${userChromeDir('Chrome')}/DevToolsActivePort`,
      '9333\n/devtools/browser/gone\n'
    )
    const beta = machine.runUserChrome('Chrome Beta', 9_222)

    const session = await machine.launcher.launch({
      url: 'https://example.com',
      platform: 'darwin',
    })

    assert.deepEqual(machine.network.opened, [
      'ws://127.0.0.1:9333/devtools/browser/gone',
      'ws://127.0.0.1:9222/devtools/browser/user-Chrome Beta',
    ])
    assert.equal(machine.spawned.length, 0, '接上了就不拉起')
    assert.deepEqual(
      beta.commands('Target.createTarget').map((call) => call.params.url),
      ['https://example.com'],
      '另开一个新标签页，不占用户已有的标签页'
    )
    assert.equal(session.driver.kind, 'external')
    assert.equal(session.driver.getURL(), 'https://example.com/')
    assert.equal(beta.downloadBehavior, null, '用户自己的 Chrome 不改下载行为')
    session.dispose()
    machine.launcher.dispose()
  })

  test('两次 launch 共用一条 WebSocket，各开各的标签页；关一个会话只关它自己的标签页', async () => {
    const machine = createMachine()
    const browser = machine.runUserChrome()

    const [first, second] = await Promise.all([
      machine.launcher.launch({ url: 'https://a.test/', platform: 'darwin' }),
      machine.launcher.launch({ url: 'https://b.test/', platform: 'darwin' }),
    ])
    const third = await machine.launcher.launch({ url: 'https://c.test/', platform: 'darwin' })

    assert.equal(machine.network.opened.length, 1, '同时 launch 也只连一次，用户只点一次「允许」')
    const created = browser.commands('Target.createTarget').length
    assert.equal(created, 3)
    const tabs = [...browser.tabs.keys()].filter((targetId) => targetId !== 'start')
    assert.equal(new Set(tabs).size, 3)

    first.dispose()
    await settle()
    assert.equal(first.driver.isDestroyed(), true)
    assert.equal(second.driver.isDestroyed(), false)
    assert.equal(third.driver.isDestroyed(), false)
    assert.equal(browser.commands('Target.closeTarget').length, 1)
    assert.equal(browser.tabs.size, 3, '另外两页与起始页都还在')
    assert.equal(browser.sockets[0].closed, false, '连接留着给后来的会话')
    first.dispose()
    await settle()
    assert.equal(browser.commands('Target.closeTarget').length, 1, 'dispose 只做一次')
    machine.launcher.dispose()
  })

  test('没有开着的浏览器就拉起：按 DevToolsActivePort 里的路径连浏览器级 WebSocket；同一个 userDataDir 再 launch 复用它', async () => {
    const machine = createMachine()
    const userDataDir = '/data/velaros-profile'

    const [first, second] = await Promise.all([
      machine.launcher.launch({ url: 'https://a.test/', userDataDir, platform: 'darwin' }),
      machine.launcher.launch({ url: 'https://b.test/', userDataDir, platform: 'darwin' }),
    ])

    assert.equal(machine.spawned.length, 1, '同一个配置目录只拉起一个 Chrome')
    const [{ args, browser }] = machine.spawned
    assert.ok(args.includes('--remote-debugging-port=0'))
    assert.ok(args.includes(`--user-data-dir=${userDataDir}`))
    assert.equal(args.at(-1), 'about:blank', '起始页是空白页，会话的页面另开')
    assert.deepEqual(machine.network.opened, ['ws://127.0.0.1:40000/devtools/browser/spawned-0'])
    assert.deepEqual(
      browser
        .commands('Target.createTarget')
        .map((call) => call.params.url)
        .sort(),
      ['https://a.test/', 'https://b.test/']
    )
    assert.deepEqual(browser.downloadBehavior, {
      behavior: 'allowAndName',
      downloadPath: join(userDataDir, 'Downloads'),
      eventsEnabled: false,
    })
    assert.equal(
      machine.reads.includes(`${userChromeDir('Chrome')}/DevToolsActivePort`),
      true,
      '缺省先找用户自己的 Chrome'
    )
    first.dispose()
    second.dispose()
    machine.launcher.dispose()
    assert.deepEqual(machine.removed, [], '用户给的配置目录不删')
  })

  test('收尾只杀自己拉起的浏览器、删自己建的临时目录，只是连上的浏览器不关', async () => {
    const machine = createMachine()
    const userBrowser = machine.runUserChrome()
    const connected = await machine.launcher.launch({ url: 'https://a.test/', platform: 'darwin' })
    const spawnedSession = await machine.launcher.launch({
      url: 'https://b.test/',
      platform: 'darwin',
      preferRunningBrowser: false,
    })
    const again = await machine.launcher.launch({
      url: 'https://c.test/',
      platform: 'darwin',
      preferRunningBrowser: false,
    })
    assert.equal(machine.spawned.length, 1, '没给 userDataDir 时复用本实例拉起的那个临时浏览器')
    const [{ child, userDataDir, browser }] = machine.spawned

    machine.launcher.dispose()
    await settle()

    assert.deepEqual(machine.kills, [[-child.pid, 'SIGTERM']], '只杀自己拉起的进程组')
    assert.deepEqual(machine.removed, [userDataDir], '删自己建的临时目录')
    assert.equal(userBrowser.running, true)
    assert.equal(userBrowser.sockets[0].closed, true, '连接断开')
    assert.equal(browser.sockets[0].closed, true)
    for (const session of [connected, spawnedSession, again])
      assert.equal(session.driver.isDestroyed(), true)
    await assert.rejects(machine.launcher.launch({ platform: 'darwin' }), {
      code: 'EXECUTION_ABORTED',
    })
  })

  test('preferRunningBrowser: false 不碰用户的 Chrome：一个用户目录都不读', async () => {
    const machine = createMachine()
    const userBrowser = machine.runUserChrome()

    const session = await machine.launcher.launch({
      url: 'https://a.test/',
      userDataDir: '/data/velaros-profile',
      platform: 'darwin',
      preferRunningBrowser: false,
    })

    assert.equal(machine.reads.filter((path) => path.startsWith(Home)).length, 0)
    assert.equal(machine.network.opened.includes(userBrowser.url), false)
    assert.equal(machine.spawned.length, 1)
    session.dispose()
    machine.launcher.dispose()
  })

  test('spawnIfNoneRunning: false 只接开着的：没有就报 external-browser-unavailable，不拉起；用户开着就照常接上', async () => {
    const machine = createMachine()

    await assert.rejects(
      machine.launcher.launch({
        url: 'https://a.test/',
        platform: 'darwin',
        spawnIfNoneRunning: false,
      }),
      (error) => {
        assert.equal(error.context?.reason, ExternalBrowserUnavailableReason)
        return true
      }
    )
    assert.equal(machine.spawned.length, 0)

    const userBrowser = machine.runUserChrome()
    const session = await machine.launcher.launch({
      url: 'https://a.test/',
      platform: 'darwin',
      spawnIfNoneRunning: false,
    })
    assert.equal(machine.spawned.length, 0)
    assert.equal(machine.network.opened.includes(userBrowser.url), true)
    session.dispose()
    machine.launcher.dispose()
  })

  test('用户退出了 Chrome：那条连接划掉，下次 launch 重新连', async () => {
    const machine = createMachine()
    const browser = machine.runUserChrome()
    const session = await machine.launcher.launch({ url: 'https://a.test/', platform: 'darwin' })

    browser.quit()
    await settle()
    assert.equal(session.driver.isDestroyed(), true)

    browser.running = true
    browser.sockets = []
    const next = await machine.launcher.launch({ url: 'https://b.test/', platform: 'darwin' })
    assert.equal(machine.network.opened.length, 2, '重新连了一条')
    assert.equal(next.driver.isDestroyed(), false)
    next.dispose()
    machine.launcher.dispose()
  })

  test('三个平台的用户 Chrome 默认配置目录，正式版、Beta、Dev、Canary 的先后', () => {
    assert.deepEqual(
      getDefaultUserDataDirCandidates('darwin', { home: '/Users/example', env: {} }),
      [
        '/Users/example/Library/Application Support/Google/Chrome',
        '/Users/example/Library/Application Support/Google/Chrome Beta',
        '/Users/example/Library/Application Support/Google/Chrome Dev',
        '/Users/example/Library/Application Support/Google/Chrome Canary',
      ]
    )
    assert.deepEqual(
      getDefaultUserDataDirCandidates('win32', {
        home: 'C:\\Users\\u',
        env: { LOCALAPPDATA: 'D:\\Local' },
      }),
      [
        'D:\\Local\\Google\\Chrome\\User Data',
        'D:\\Local\\Google\\Chrome Beta\\User Data',
        'D:\\Local\\Google\\Chrome Dev\\User Data',
        'D:\\Local\\Google\\Chrome SxS\\User Data',
      ]
    )
    assert.deepEqual(getDefaultUserDataDirCandidates('linux', { home: '/home/u', env: {} }), [
      '/home/u/.config/google-chrome',
      '/home/u/.config/google-chrome-beta',
      '/home/u/.config/google-chrome-unstable',
      '/home/u/.config/google-chrome-canary',
    ])
    assert.equal(
      getDefaultUserDataDirCandidates('linux', {
        home: '/home/u',
        env: { XDG_CONFIG_HOME: '/x' },
      })[0],
      '/x/google-chrome'
    )
  })
})

describe('运行时的外部页面', () => {
  test('hasExternalPage：开了就有，用户退出浏览器就没有；不进动作队列、不抛', async () => {
    const machine = createMachine()
    const browser = machine.runUserChrome()
    const runtime = createElectronBrowserRuntime({ externalBrowserLauncher: machine.launcher })
    const context = { url: 'https://example.com/', workspaceRoot: '/tmp/velaros-test-site' }

    assert.equal(runtime.hasExternalPage('chat-1'), false)
    await runtime.launchExternalBrowserPage('chat-1', context, { platform: 'darwin' })
    assert.equal(runtime.hasExternalPage('chat-1'), true)
    assert.equal(runtime.hasExternalPage('chat-2'), false)

    browser.quit()
    await settle()
    assert.equal(runtime.hasExternalPage('chat-1'), false)
    runtime.dispose()
  })

  test('运行时 dispose 收掉启动器；setOptions 换了启动器就收掉换下来的，同一个再给一遍不收', () => {
    const disposed = []
    const launcherNamed = (name) => ({
      launch: () => Promise.reject(new Error('测试里不开页面')),
      dispose: () => disposed.push(name),
    })
    const first = launcherNamed('first')
    const second = launcherNamed('second')
    const runtime = createElectronBrowserRuntime({ externalBrowserLauncher: first })

    runtime.setOptions({ externalBrowserLauncher: second })
    runtime.setOptions({ externalBrowserLauncher: second })
    assert.deepEqual(disposed, ['first'])
    runtime.dispose()
    assert.deepEqual(disposed, ['first', 'second'])
  })
})
