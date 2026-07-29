import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { HTML_ARTIFACT_HEIGHT_CONTROLLER_FACTORY_SOURCE } from '../dist/height-controller.js'
import {
  buildHtmlArtifactShellDocument,
  DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT,
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
    assert.match(shell, /\)\(720\);function invalidateHeightMeasurement/)
    assert.match(shell, /pendingPatches=\[\];invalidateHeightMeasurement\(\);applyPatches\(patches\)/)
    assert.match(shell, /shouldPublishMeasuredSize/)
    assert.doesNotMatch(shell, /widgetBridge|show_widget/)
  })

  test('uses a finite default height cap for viewport-coupled artifacts', () => {
    const shell = buildHtmlArtifactShellDocument()

    assert.equal(DEFAULT_HTML_ARTIFACT_MAX_REPORTED_HEIGHT, 1200)
    assert.match(shell, /\)\(1200\);function invalidateHeightMeasurement/)
  })

  test('settles shrink, feedback, deduplication, and hard caps in one controller', () => {
    const createHtmlArtifactHeightController = Function(
      `return (${HTML_ARTIFACT_HEIGHT_CONTROLLER_FACTORY_SOURCE})`
    )()
    const controller = createHtmlArtifactHeightController(720)

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
})
