import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { HTML_ARTIFACT_SIZE_CONTROLLER_FACTORY_SOURCE } from '../dist/size-controller.js'
import {
  buildHtmlArtifactShellDocument,
  DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT,
  DEFAULT_HTML_ARTIFACT_MAX_WIDTH_RATIO,
  HTML_ARTIFACT_WHEEL_MESSAGE_TYPE,
  inferHtmlArtifactContentKind,
  normalizeHtmlArtifactExternalUrl,
  normalizeHtmlArtifactSource,
  resolveHtmlArtifactFrameFit,
} from '../dist/runtime.js'

describe('HTML artifact runtime', () => {
  test('normalizes whole-source wrappers without touching ordinary HTML', () => {
    assert.equal(normalizeHtmlArtifactSource('<main>Ready</main>'), '<main>Ready</main>')
    assert.equal(
      normalizeHtmlArtifactSource('<![CDATA[<style>body{color:red}</style>]]>'),
      '<style>body{color:red}</style>'
    )
    assert.equal(normalizeHtmlArtifactSource('```html\n<svg></svg>\n```'), '<svg></svg>')
    assert.equal(inferHtmlArtifactContentKind('```svg\n<svg></svg>\n```'), 'svg')
  })

  test('accepts explicit web URLs and rejects active or relative schemes', () => {
    assert.equal(normalizeHtmlArtifactExternalUrl('https://example.com/a'), 'https://example.com/a')
    assert.equal(normalizeHtmlArtifactExternalUrl('javascript:alert(1)'), null)
    assert.equal(normalizeHtmlArtifactExternalUrl('/relative'), null)
  })

  test('scales natural dimensions into a stable host viewport', () => {
    assert.deepEqual(
      resolveHtmlArtifactFrameFit({
        fallbackHeight: 360,
        maxViewportWidth: 600,
        naturalHeight: 800,
        naturalWidth: 1200,
      }),
      {
        contentHeight: 800,
        contentWidth: 1200,
        locked: true,
        scale: 0.5,
        viewportHeight: 400,
        viewportWidth: 600,
      }
    )
  })

  test('builds a configurable, product-neutral iframe shell', () => {
    const shell = buildHtmlArtifactShellDocument({
      bridgeMessages: {
        render: 'demo-render',
        generic: 'demo-message',
      },
      maxReportedHeight: 720,
      rootId: 'demo-root',
    })

    assert.match(shell, /id="demo-root"/)
    assert.match(shell, /demo-render/)
    assert.match(shell, /demo-message/)
    assert.match(shell, /window\.artifactBridge/)
    assert.match(shell, new RegExp(HTML_ARTIFACT_WHEEL_MESSAGE_TYPE))
    assert.match(shell, /\)\(720,3\);function invalidateHeightMeasurement/)
    assert.match(shell, /pendingPatches=\[\];invalidateHeightMeasurement\(\);applyPatches\(patches\)/)
    assert.match(shell, /shouldPublishMeasuredSize/)
    assert.doesNotMatch(shell, /widgetBridge|show_widget/)
  })

  test('uses a finite default height cap for viewport-coupled artifacts', () => {
    const shell = buildHtmlArtifactShellDocument()

    assert.equal(DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT, 1200)
    assert.equal(DEFAULT_HTML_ARTIFACT_MAX_WIDTH_RATIO, 3)
    assert.match(shell, /\)\(1200,3\);function invalidateHeightMeasurement/)
  })

  test('settles shrink, feedback, deduplication, and hard caps in one controller', () => {
    const createHtmlArtifactSizeController = Function(
      `return (${HTML_ARTIFACT_SIZE_CONTROLLER_FACTORY_SOURCE})`
    )()
    const controller = createHtmlArtifactSizeController(720)

    assert.equal(
      controller.resolve({ baseHeight: 2000, clientHeight: 240, scrollHeight: 2000 }),
      720
    )

    controller.invalidate()
    assert.equal(
      controller.resolve({ baseHeight: 352, clientHeight: 376, scrollHeight: 352 }),
      352
    )
    assert.equal(controller.shouldPublish({ height: 352, width: 560 }), true)
    assert.equal(controller.shouldPublish({ height: 352, width: 560 }), false)

    controller.invalidate()
    assert.equal(
      controller.resolve({ baseHeight: 300, clientHeight: 240, scrollHeight: 300 }),
      300
    )
    assert.equal(
      controller.resolve({ baseHeight: 360, clientHeight: 300, scrollHeight: 360 }),
      360
    )
    assert.equal(
      controller.resolve({ baseHeight: 420, clientHeight: 360, scrollHeight: 420 }),
      360
    )
    assert.equal(
      controller.resolve({ baseHeight: 480, clientHeight: 420, scrollHeight: 480 }),
      360
    )
  })

  test('freezes a content width that grows with the frame the host gives back', () => {
    const createHtmlArtifactSizeController = Function(
      `return (${HTML_ARTIFACT_SIZE_CONTROLLER_FACTORY_SOURCE})`
    )()
    const controller = createHtmlArtifactSizeController(1200, 3)

    // 100vw 子元素 / 百分比定位的装饰:宿主每加宽一次,测量宽就跟着长一次。
    assert.equal(controller.resolveWidth({ baseWidth: 792, clientWidth: 760 }), 792)
    assert.equal(controller.resolveWidth({ baseWidth: 824, clientWidth: 792 }), 824)
    assert.equal(controller.resolveWidth({ baseWidth: 856, clientWidth: 824 }), 760)
    // 冻结是粘滞的:DOM 变更不得解冻,否则每次 mutation 都会重启这条跑飞回路。
    controller.invalidate()
    assert.equal(controller.resolveWidth({ baseWidth: 1600, clientWidth: 760 }), 760)
  })

  test('keeps a genuinely wide layout and caps a runaway one', () => {
    const createHtmlArtifactSizeController = Function(
      `return (${HTML_ARTIFACT_SIZE_CONTROLLER_FACTORY_SOURCE})`
    )()

    // 定宽 1400 的设计稿:宿主加宽后测量宽不再长,是真实需求宽,原样回传由宿主缩放。
    const stable = createHtmlArtifactSizeController(1200, 3)
    assert.equal(stable.resolveWidth({ baseWidth: 1432, clientWidth: 760 }), 1432)
    assert.equal(stable.resolveWidth({ baseWidth: 1432, clientWidth: 1432 }), 1432)

    // 一步跳到 3 倍以上:来不及攒够两轮证据,硬上限直接兜住。
    const capped = createHtmlArtifactSizeController(1200, 3)
    assert.equal(capped.resolveWidth({ baseWidth: 9000, clientWidth: 760 }), 2280)
  })

  test('stops scaling instead of shrinking an artifact into a sliver', () => {
    const fit = resolveHtmlArtifactFrameFit({
      fallbackHeight: 360,
      maxViewportWidth: 600,
      naturalHeight: 800,
      naturalWidth: 6000,
    })

    assert.equal(fit.scale, 1)
    assert.equal(fit.viewportWidth, 600)
    assert.equal(fit.viewportHeight, 800)
  })
})
