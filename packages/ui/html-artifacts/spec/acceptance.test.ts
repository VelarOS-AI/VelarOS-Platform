/**
 * HTML 制品的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 只经根入口，只测对外承诺的行为；utils 里的实现细节在 test/ 下补。
 */

import { describe, expect, test } from 'bun:test'

import {
  HtmlArtifactDefaults,
  HtmlArtifactProtocolLimitDefaults,
  htmlArtifactDocuments,
  htmlArtifactProtocol,
  mountHtmlArtifact,
} from '../index.js'
import type { HtmlArtifactHostError, HtmlArtifactProtocolEvent } from '../index.js'
import { bridgeType, createFakeEnvironment, FakeDocument, FakeTarget, FakeWindow } from './support.js'

/** 把一段源码切成固定长度的 chunk 喂进去，返回全部事件。 */
function streamInChunks(source: string, chunkSize: number): HtmlArtifactProtocolEvent[] {
  const state = htmlArtifactProtocol.createState({ enabled: true })
  const events: HtmlArtifactProtocolEvent[] = []

  for (let offset = 0; offset < source.length; offset += chunkSize) {
    events.push(...htmlArtifactProtocol.applyChunk(state, source.slice(offset, offset + chunkSize)))
  }
  events.push(...htmlArtifactProtocol.finalize(state))

  return events
}

describe('增量协议', () => {
  test('INV-1 流可以在任意字符处切开，只有完整安全的协议边界才发出去', () => {
    const source = [
      '<artifact version="1" id="profile-card" title="Profile">',
      '<patch type="replace"><main id="app"></main></patch>',
      '<patch type="append" target="#app"><h1>Hello</h1></patch>',
      '<patch type="style" id="base">#app { color: rebeccapurple; }</patch>',
      '<patch type="script" id="boot">window.ready = true</patch>',
      '</artifact>',
    ].join('')

    for (const chunkSize of [1, 3, 7, source.length]) {
      const events = streamInChunks(source, chunkSize)
      const patches = events.flatMap((event) => (event.type === 'artifact-patch' ? [event.patch] : []))

      expect(events.filter((event) => event.type === 'artifact-open')).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('artifact-close')
      expect([...new Set(patches.map((patch) => patch.type))]).toEqual(['append', 'style', 'script'])
      // 每一条 HTML 补丁都是闭合完整的片段，不会把 `<h1>Hel` 这样的残片送进 iframe。
      for (const patch of patches) {
        if (patch.type !== 'append' && patch.type !== 'replace') continue
        expect(patch.html.split('<').length).toBe(patch.html.split('>').length)
      }
      // Base64 载荷里可以藏着 `</patch>`，解码之后原样交付。
      expect(patches.some((patch) => patch.type === 'append' && patch.html.includes('Hello'))).toBe(true)
    }

    const encoded = Buffer.from("window.message = '</patch>'", 'utf8').toString('base64')
    const encodedEvents = streamInChunks(
      `<artifact version="1" id="encoded" title="Encoded"><patch type="script" id="boot" encoding="base64">${encoded}</patch></artifact>`,
      5
    )
    const script = encodedEvents.flatMap((event) =>
      event.type === 'artifact-patch' && event.patch.type === 'script' ? [event.patch] : []
    )
    expect(script.at(-1)?.code).toBe("window.message = '</patch>'")

    // 认不出的协议版本：一个制品都不认，整段原样当 Markdown。
    const future = '<artifact version="99" id="future" title="Future">hello</artifact>'
    const futureEvents = streamInChunks(future, 2)
    expect(futureEvents.some((event) => event.type === 'artifact-open')).toBe(false)
    expect(
      futureEvents.flatMap((event) => (event.type === 'markdown' ? [event.text] : [])).join('')
    ).toBe(future)
  })

  test('INV-4 协议资源上限对超长流生效，缺省值就是常量表里那四个', () => {
    const defaults = htmlArtifactProtocol.createState({ enabled: true }).limits
    expect(defaults).toEqual({
      maxActionPayloadLength: HtmlArtifactProtocolLimitDefaults.maxActionPayloadLength,
      maxArtifactHtmlLength: HtmlArtifactProtocolLimitDefaults.maxArtifactHtmlLength,
      maxArtifactProtocolTextLength: HtmlArtifactProtocolLimitDefaults.maxArtifactProtocolTextLength,
      maxBufferLength: HtmlArtifactProtocolLimitDefaults.maxBufferLength,
    })

    const parser = htmlArtifactProtocol.createParser({
      enabled: true,
      limits: {
        maxArtifactHtmlLength: 24,
        maxArtifactProtocolTextLength: 32,
        maxActionPayloadLength: 40,
        maxBufferLength: 64,
      },
    })
    parser.write('<artifact version="1" id="huge" title="Huge"><patch type="append">')
    parser.write('<p>'.repeat(200))
    parser.finish()

    const snapshot = parser.getSnapshot('huge')
    expect(snapshot).not.toBeNull()
    expect(snapshot?.html.length).toBeLessThanOrEqual(24)
    expect((snapshot?.protocolText ?? '').length).toBeLessThanOrEqual(32)
    expect(parser.state.buffer.length).toBeLessThanOrEqual(64)

    // 恶意流：一直不闭合的标签也不能让缓冲区无限攒。
    const unbounded = htmlArtifactProtocol.createState({ enabled: true, limits: { maxBufferLength: 128 } })
    for (let round = 0; round < 50; round += 1) {
      htmlArtifactProtocol.applyChunk(unbounded, '<artifact version="1" id="x" title="'.repeat(4))
    }
    expect(unbounded.buffer.length).toBeLessThanOrEqual(128)
  })
})

describe('沙箱边界', () => {
  test('INV-2 iframe 固定 allow-scripts，非法外链到不了 onLink', async () => {
    const document = new FakeDocument()
    const window = new FakeWindow()
    const links: string[] = []
    const errors: HtmlArtifactHostError[] = []
    const controller = mountHtmlArtifact(new FakeTarget() as unknown as HTMLElement, {
      environment: createFakeEnvironment(document, window, () => 'sandbox-1') as never,
      onLink: (url) => links.push(url),
      onError: (error) => errors.push(error),
    })
    const iframe = document.iframe

    expect(iframe.attributes.get('sandbox')).toBe('allow-scripts')
    expect(iframe.referrerPolicy).toBe('no-referrer')
    iframe.dispatch('load')

    const link = bridgeType(iframe.srcdoc, 'link')
    expect(link).toBeDefined()
    for (const url of ['javascript:alert(1)', '/relative', 'data:text/html,<b>x', '']) {
      window.dispatch('message', { data: { type: link, url }, source: iframe.contentWindow })
    }
    expect(links).toEqual([])
    expect(errors.every((error) => error.phase === 'security')).toBe(true)
    expect(errors.length).toBeGreaterThan(0)

    window.dispatch('message', {
      data: { type: link, url: 'https://example.com/docs' },
      source: iframe.contentWindow,
    })
    expect(links).toEqual(['https://example.com/docs'])

    // 同一条判定在文档能力面上也成立，宿主自己托管 iframe 时用它。
    expect(htmlArtifactDocuments.normalizeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(htmlArtifactDocuments.normalizeExternalUrl('https://example.com/a')).toBe('https://example.com/a')

    controller.dispose()
    expect(window.listeners.get('message')?.size ?? 0).toBe(0)
  })

  test('INV-3 上报高度按 maxHeight 封顶，iframe 内外两侧同一个数', () => {
    const document = new FakeDocument()
    const window = new FakeWindow()
    const controller = mountHtmlArtifact(new FakeTarget() as unknown as HTMLElement, {
      environment: createFakeEnvironment(document, window, () => 'height-1') as never,
      initialHeight: 100,
      minHeight: 60,
      maxHeight: 200,
    })
    const iframe = document.iframe

    expect(iframe.style.height).toBe('100px')
    iframe.dispatch('load')

    const resize = bridgeType(iframe.srcdoc, 'resize')
    expect(resize).toBeDefined()
    window.dispatch('message', {
      data: { type: resize, naturalHeight: 999 },
      source: iframe.contentWindow,
    })
    expect(iframe.style.height).toBe('200px')

    window.dispatch('message', {
      data: { type: resize, naturalHeight: 4 },
      source: iframe.contentWindow,
    })
    expect(iframe.style.height).toBe('60px')

    // iframe 内部也拿到同一个上限：注入脚本里的尺寸控制器按 200 建。
    expect(iframe.srcdoc).toContain(')(200,')
    controller.dispose()
  })

  test('INV-5 注入脚本里的缺省上限就是常量表里那两个数字', () => {
    const shell = htmlArtifactDocuments.buildShellDocument()
    const document = htmlArtifactDocuments.buildDocument('<main>hi</main>')
    const expected = `)(${HtmlArtifactDefaults.maxReportedHeight},${HtmlArtifactDefaults.maxWidthRatio});`

    expect(shell).toContain(expected)
    expect(document).toContain(expected)
    expect(shell).toContain(`id="${HtmlArtifactDefaults.rootId}"`)
    // 脚本里不再另抄一份：整份文档里出现的这两个数字只来自常量表插值。
    expect(htmlArtifactDocuments.buildShellDocument({ maxReportedHeight: 720 })).toContain(
      `)(720,${HtmlArtifactDefaults.maxWidthRatio});`
    )
  })
})
