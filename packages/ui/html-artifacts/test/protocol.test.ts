/** 增量协议的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补解析器生命周期与边角情形。 */

import { describe, expect, test } from 'bun:test'

import { htmlArtifactProtocol } from '../index.js'
import type { HtmlArtifactProtocolEvent } from '../index.js'

/** 把一段源码切成固定长度的 chunk 喂进一个新状态，返回事件与最终状态。 */
function streamInChunks(source: string, chunkSize = 7) {
  const state = htmlArtifactProtocol.createState({ enabled: true })
  const events: HtmlArtifactProtocolEvent[] = []

  for (let offset = 0; offset < source.length; offset += chunkSize) {
    events.push(...htmlArtifactProtocol.applyChunk(state, source.slice(offset, offset + chunkSize)))
  }
  events.push(...htmlArtifactProtocol.finalize(state))

  return { events, state }
}

describe('解析器生命周期', () => {
  test('自己管状态的解析器：写、收尾、取内容、重置', () => {
    const parser = htmlArtifactProtocol.createParser({ enabled: true })

    parser.write('<artifact version="1" id="owned" title="Owned">')
    parser.write('<patch type="append"><p>Ready</p></patch></artifact>')
    parser.finish()

    expect(parser.getSnapshot('owned')?.html ?? '').toMatch(/Ready/)
    parser.reset()
    expect(parser.getSnapshot('owned')).toBeNull()
    expect(parser.state.mode).toBe('markdown')
  })

  test('state 快照是冻结的，外面看得见改不动', () => {
    const parser = htmlArtifactProtocol.createParser({ enabled: true })
    parser.write('<artifact version="1" id="one" title="One"><patch type="append">hello</patch>')
    const state = parser.state

    expect(() => {
      ;(state.artifactsById as Record<string, unknown>).one = { id: 'two' }
    }).toThrow()
    expect(() => {
      ;(state.limits as Record<string, number>).maxBufferLength = 1
    }).toThrow()
    expect(parser.getSnapshot('one')?.html).toBe('hello')
  })
})

describe('分片解析', () => {
  test('制品在任意 chunk 边界上都能完整解出来', () => {
    const source = [
      '<artifact version="1" id="profile-card" title="Profile">',
      '<patch type="replace"><main id="app"></main></patch>',
      '<patch type="append" target="#app"><h1>Hello</h1></patch>',
      '<patch type="style" id="base">#app { color: rebeccapurple; }</patch>',
      '<patch type="script" id="boot">window.ready = true</patch>',
      '</artifact>',
    ].join('')

    const { events, state } = streamInChunks(source, 3)
    const patches = events.flatMap((event) => (event.type === 'artifact-patch' ? [event.patch] : []))

    expect(events.filter((event) => event.type === 'artifact-open')).toHaveLength(1)
    expect(events.some((event) => event.type === 'artifact-update')).toBe(true)
    expect([...new Set(patches.map((patch) => patch.type))]).toEqual(['append', 'style', 'script'])
    expect(events.at(-1)?.type).toBe('artifact-close')
    expect(state.artifactsById['profile-card'].html).toMatch(/main id="app"/)
    expect(patches.some((patch) => patch.type === 'append' && /Hello/.test(patch.html))).toBe(true)
  })

  test('认不出的协议版本整段原样当 Markdown', () => {
    const source = '<artifact version="99" id="future" title="Future">hello</artifact>'
    const { events } = streamInChunks(source, 2)

    expect(events.some((event) => event.type === 'artifact-open')).toBe(false)
    expect(events.flatMap((event) => (event.type === 'markdown' ? [event.text] : [])).join('')).toBe(
      source
    )
  })

  test('base64 载荷解码后原样交付，哪怕里面藏着协议闭合标签', () => {
    const encoded = Buffer.from("window.message = '</patch>'", 'utf8').toString('base64')
    const source = `<artifact version="1" id="encoded" title="Encoded"><patch type="script" id="boot" encoding="base64">${encoded}</patch></artifact>`
    const { events } = streamInChunks(source, 5)
    const script = events.flatMap((event) =>
      event.type === 'artifact-patch' && event.patch.type === 'script' ? [event.patch] : []
    )

    expect(script.at(-1)?.code).toBe("window.message = '</patch>'")
  })

  test('流断在半路时收尾干净，不留下流式残留状态', () => {
    const state = htmlArtifactProtocol.createState({ enabled: true })
    htmlArtifactProtocol.applyChunk(
      state,
      '<artifact version="1" id="partial" title="Partial"><patch type="append"><p>Saved'
    )

    const events = htmlArtifactProtocol.finalize(state)

    expect(events.at(-1)?.type).toBe('artifact-close')
    expect(state.mode).toBe('markdown')
    expect(state.activeArtifact).toBeNull()
    expect(state.activeAction).toBeNull()
  })
})
