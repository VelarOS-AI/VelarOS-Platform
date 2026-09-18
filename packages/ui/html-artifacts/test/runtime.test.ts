/** 浏览器宿主的实现细节测试：注入面、跨 realm 挂载目标、消息来源校验、复用与清理。 */

import { runInNewContext } from 'node:vm'

import { describe, expect, test } from 'bun:test'

import { mountHtmlArtifact } from '../index.js'
import type { HtmlArtifactHostError } from '../index.js'
import {
  bridgeType,
  createFakeEnvironment,
  FakeDocument,
  FakeIframe,
  FakeTarget,
  FakeWindow,
  withFakeDom,
} from '../spec/support.js'

describe('注入面与挂载目标', () => {
  test('宿主可以换掉浏览器边界，reset 会换一套新的桥接消息名', () => {
    const document = new FakeDocument()
    const window = new FakeWindow()
    let nextId = 0
    const environment = createFakeEnvironment(document, window, () => `test-${(nextId += 1)}`)

    const controller = mountHtmlArtifact(new FakeTarget() as unknown as HTMLElement, {
      environment: environment as never,
    })
    expect(controller.iframe.srcdoc).toMatch(/velaros:html-artifact:test-1:render/)
    controller.reset()
    expect(controller.iframe.srcdoc).toMatch(/velaros:html-artifact:test-2:render/)
    controller.dispose()
    expect(window.listeners.get('message')?.size ?? 0).toBe(0)
  })

  test('挂载目标的方法来自另一个 realm 时照样认', () => {
    // 另一个 realm（另一个 iframe、webview 桥）造出来的函数：`instanceof Function` 为假，
    // `typeof` 为 'function'。宿主跨 realm 递进来的挂载目标不能被当成「不是元素」而拒绝。
    const foreignTarget = runInNewContext(
      '({ children: [], replaceChildren(...items) { this.children = items } })'
    ) as { children: unknown[], replaceChildren: (...items: unknown[]) => void }
    expect(foreignTarget.replaceChildren instanceof Function).toBe(false)

    const document = new FakeDocument()
    const window = new FakeWindow()
    const controller = mountHtmlArtifact(foreignTarget as unknown as HTMLElement, {
      environment: createFakeEnvironment(document, window, () => 'foreign-1') as never,
    })
    expect(foreignTarget.children).toHaveLength(1)
    controller.dispose()
  })

  test('控制器的方法解构出来单独用也绑着 this', async () => {
    await withFakeDom(async () => {
      const controller = mountHtmlArtifact(new FakeTarget() as unknown as HTMLElement)
      const { write, finish, reset, dispose } = controller

      expect(() => write('plain markdown')).not.toThrow()
      expect(() => finish()).not.toThrow()
      expect(() => reset()).not.toThrow()
      expect(() => dispose()).not.toThrow()
    })
  })
})

describe('流、传输、复用与清理', () => {
  test('一个实例管完流式渲染、有界尺寸、回调、reset 与 dispose', async () => {
    await withFakeDom(async ({ document, window }) => {
      const prompts: string[] = []
      const links: string[] = []
      const errors: HtmlArtifactHostError[] = []
      const target = new FakeTarget()
      const controller = mountHtmlArtifact(target as unknown as HTMLElement, {
        initialHeight: 100,
        minHeight: 60,
        maxHeight: 200,
        onError: (error) => errors.push(error),
        onLink: (url) => links.push(url),
        onPrompt: (prompt) => prompts.push(prompt),
      })
      const iframe = document.iframe
      const source =
        '<artifact version="1" id="card" title="Card">'
        + '<patch type="replace"><main id="app"></main></patch>'
        + '<patch type="append" target="#app"><h1>Hello</h1></patch>'
        + '</artifact>'

      expect(target.children[0]).toBe(iframe)
      expect(iframe.attributes.get('sandbox')).toBe('allow-scripts')
      expect(iframe.style.height).toBe('100px')

      controller.write(source)
      expect(iframe.contentWindow.messages).toHaveLength(0)
      iframe.dispatch('load')
      expect(await controller.ready).toBe(iframe as unknown as HTMLIFrameElement)
      expect(
        iframe.contentWindow.messages.some(({ payload }) => String(payload.html ?? '').includes('<main'))
      ).toBe(true)
      expect(controller.getSnapshot('card')?.html ?? '').toMatch(/<main id="app"><\/main>/)
      expect(
        iframe.contentWindow.messages.some(({ payload }) =>
          (payload.patches as Array<{ html?: string }> | undefined)?.some((patch) =>
            patch.html?.includes('Hello')
          )
        )
      ).toBe(true)

      const resize = bridgeType(iframe.srcdoc, 'resize')
      const prompt = bridgeType(iframe.srcdoc, 'prompt')
      const link = bridgeType(iframe.srcdoc, 'link')
      expect(resize).toBeDefined()
      expect(prompt).toBeDefined()
      expect(link).toBeDefined()

      window.dispatch('message', {
        data: { type: resize, naturalHeight: 999 },
        origin: 'null',
        source: iframe.contentWindow,
      })
      expect(iframe.style.height).toBe('200px')

      window.dispatch('message', {
        data: { type: prompt, prompt: 'Continue' },
        origin: 'null',
        source: iframe.contentWindow,
      })
      window.dispatch('message', {
        data: { type: link, url: 'javascript:alert(1)' },
        origin: 'null',
        source: iframe.contentWindow,
      })
      window.dispatch('message', {
        data: { type: link, url: 'https://example.com/docs' },
        origin: 'null',
        source: iframe.contentWindow,
      })
      expect(prompts).toEqual(['Continue'])
      expect(links).toEqual(['https://example.com/docs'])
      expect(errors.at(-1)?.phase).toBe('security')

      window.dispatch('message', {
        data: { type: 'velaros:html-artifact-wheel', deltaX: 2, deltaY: 12 },
        origin: 'null',
        source: iframe.contentWindow,
      })
      expect(window.scrollCalls).toEqual([{ left: 2, top: 12 }])

      controller.reset()
      expect(iframe.style.height).toBe('100px')
      expect(controller.getSnapshot()).toBeNull()
      const messageCountBeforeReload = iframe.contentWindow.messages.length
      controller.write(source)
      expect(iframe.contentWindow.messages).toHaveLength(messageCountBeforeReload)
      iframe.dispatch('load')
      expect(iframe.contentWindow.messages.length > messageCountBeforeReload).toBe(true)

      controller.dispose()
      expect(iframe.removed).toBe(true)
      expect(window.listeners.get('message')?.size ?? 0).toBe(0)
      expect(() => controller.write('later')).toThrow(/dispose/)
    })
  })

  test('consume 吃掉一条异步流并给出最后一个制品', async () => {
    await withFakeDom(async ({ document }) => {
      const controller = mountHtmlArtifact(new FakeTarget() as unknown as HTMLElement)
      document.iframe.dispatch('load')

      async function* chunks() {
        yield '<artifact version="1" id="async" title="Async">'
        yield '<patch type="append"><p>Done</p></patch></artifact>'
      }

      const snapshot = await controller.consume(chunks())
      expect(snapshot?.id).toBe('async')
      expect(snapshot?.html ?? '').toMatch(/Done/)
      controller.dispose()
    })
  })

  test('只认来自自己那个 iframe contentWindow 的消息，不看 origin', async () => {
    await withFakeDom(async ({ document, window }) => {
      const prompts: string[] = []
      const controller = mountHtmlArtifact(new FakeTarget() as unknown as HTMLElement, {
        onPrompt: (prompt) => prompts.push(prompt),
      })
      const iframe = document.iframe
      const prompt = bridgeType(iframe.srcdoc, 'prompt')
      expect(prompt).toBeDefined()

      iframe.dispatch('load')

      window.dispatch('message', {
        data: { type: prompt, prompt: 'trusted opaque frame' },
        origin: 'null',
        source: iframe.contentWindow,
      })
      expect(prompts).toEqual(['trusted opaque frame'])

      window.dispatch('message', {
        data: { type: prompt, prompt: 'missing source' },
        origin: 'null',
        source: null,
      })
      window.dispatch('message', {
        data: { type: prompt, prompt: 'forged source' },
        origin: 'null',
        source: {},
      })
      window.dispatch('message', {
        data: { type: prompt, prompt: 'different frame' },
        origin: 'null',
        source: new FakeIframe().contentWindow,
      })
      expect(prompts).toEqual(['trusted opaque frame'])

      window.dispatch('message', {
        data: { type: prompt, prompt: 'trusted non-opaque frame' },
        origin: 'https://example.com',
        source: iframe.contentWindow,
      })
      expect(prompts).toEqual(['trusted opaque frame', 'trusted non-opaque frame'])

      controller.dispose()
    })
  })
})
