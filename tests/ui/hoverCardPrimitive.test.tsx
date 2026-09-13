import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { HoverCard } from '../../packages/ui/src/primitives/overlays/HoverCard'
import {
  HoverCardArrowSize,
  HoverCardController,
  resolveHoverCardEdgeOffset,
  resolveHoverCardPlacement,
} from '../../packages/ui/src/primitives/overlays/hoverCardController'
import { resolvePopoverPosition } from '../../packages/ui/src/primitives/overlays/popoverPosition'
import { CompactToolRow } from '../../packages/ui/src/product/layout/CompactToolRow'

function readSource(relative: string): string {
  return readFileSync(path.resolve(process.cwd(), relative), 'utf8')
}

/** 取出某条 CSS 规则的声明体（第一条匹配的选择器）。 */
function readRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `missing rule ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

/** 手动推进的计时器：只按时间顺序触发到期回调，不依赖真实时钟。 */
function createManualClock(): {
  schedule: (delayMs: number, callback: () => void) => { cancel: () => boolean }
  advance: (ms: number) => void
} {
  let now = 0
  const pending = new Set<{ at: number; callback: () => void }>()

  return {
    schedule: (delayMs, callback) => {
      const entry = { at: now + delayMs, callback }
      pending.add(entry)
      return { cancel: () => pending.delete(entry) }
    },
    advance: (ms) => {
      const target = now + ms
      for (;;) {
        const due = [...pending].filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        pending.delete(due)
        now = due.at
        due.callback()
      }
      now = target
    },
  }
}

function createController(options: { selectionWithin?: () => boolean } = {}): {
  controller: HoverCardController
  clock: ReturnType<typeof createManualClock>
  changes: boolean[]
} {
  const clock = createManualClock()
  const changes: boolean[] = []
  const controller = new HoverCardController({
    schedule: clock.schedule,
    readDelays: () => ({ openDelayMs: 300, closeDelayMs: 200 }),
    hasSelectionWithin: options.selectionWithin ?? (() => false),
    onOpenChange: (open) => changes.push(open),
  })
  return { controller, clock, changes }
}

void describe('HoverCard open / close timing', () => {
  void test('opens only after the pointer rests on the trigger and ignores a pass-through', () => {
    const { controller, clock } = createController()

    controller.pointerEnterTrigger()
    clock.advance(120)
    controller.pointerLeaveTrigger()
    clock.advance(1_000)
    assert.equal(controller.open, false)

    controller.pointerEnterTrigger()
    clock.advance(299)
    assert.equal(controller.open, false)
    // 在行内移动不重排计时：延时从首次进入算起。
    controller.pointerEnterTrigger()
    clock.advance(1)
    assert.equal(controller.open, true)
    controller.dispose()
  })

  void test('stays open while the pointer travels from the trigger into the card and closes after leaving both', () => {
    const { controller, clock, changes } = createController()

    controller.pointerEnterTrigger()
    clock.advance(300)
    controller.pointerLeaveTrigger()
    clock.advance(150)
    controller.pointerEnterCard()
    clock.advance(1_000)
    assert.equal(controller.open, true)

    controller.pointerLeaveCard()
    clock.advance(199)
    assert.equal(controller.open, true)
    clock.advance(1)
    assert.equal(controller.open, false)
    assert.deepEqual(changes, [true, false])
    controller.dispose()
  })

  void test('keeps a selection inside the card alive until it is cleared', () => {
    let selectionInside = false
    const { controller, clock } = createController({ selectionWithin: () => selectionInside })

    controller.pointerEnterTrigger()
    clock.advance(300)
    controller.pointerLeaveTrigger()
    controller.pointerEnterCard()
    controller.pressCard()
    // 按住拖选时指针被拖出气泡。
    controller.pointerLeaveCard()
    clock.advance(1_000)
    assert.equal(controller.open, true)

    selectionInside = true
    controller.releasePress()
    clock.advance(1_000)
    assert.equal(controller.open, true)

    selectionInside = false
    controller.selectionChanged()
    clock.advance(200)
    assert.equal(controller.open, false)
    controller.dispose()
  })

  void test('an Escape while hovering keeps the card closed until the pointer leaves the trigger', () => {
    const { controller, clock } = createController()

    controller.pointerEnterTrigger()
    clock.advance(300)
    controller.requestClose()
    assert.equal(controller.open, false)
    controller.pointerEnterTrigger()
    clock.advance(1_000)
    assert.equal(controller.open, false)

    controller.pointerLeaveTrigger()
    controller.pointerEnterTrigger()
    clock.advance(300)
    assert.equal(controller.open, true)
    controller.dispose()
  })

  void test('opens from keyboard focus and closes on blur', () => {
    const { controller, clock } = createController()

    controller.focusTrigger()
    clock.advance(300)
    assert.equal(controller.open, true)
    controller.blurTrigger()
    clock.advance(200)
    assert.equal(controller.open, false)
    controller.dispose()
  })

  void test('keeps a single card open: a newly opened card closes the previous one', () => {
    const first = createController()
    const second = createController()

    first.controller.focusTrigger()
    first.clock.advance(300)
    assert.equal(first.controller.open, true)

    second.controller.pointerEnterTrigger()
    second.clock.advance(300)
    assert.equal(second.controller.open, true)
    assert.equal(first.controller.open, false)
    assert.deepEqual(first.changes, [true, false])
    first.controller.dispose()
    second.controller.dispose()
  })

  void test('opens once content arrives while the pointer already rests on the trigger', () => {
    const { controller, clock } = createController()

    controller.setInactive(true)
    controller.pointerEnterTrigger()
    clock.advance(1_000)
    assert.equal(controller.open, false)

    // 比如量出行文字被截断、或工具结果回来后才有内容：不必等指针离开再进来。
    controller.setInactive(false)
    clock.advance(299)
    assert.equal(controller.open, false)
    clock.advance(1)
    assert.equal(controller.open, true)
    controller.dispose()
  })

  void test('an inactive card never opens and closes at once when it becomes inactive', () => {
    const { controller, clock } = createController()

    controller.pointerEnterTrigger()
    clock.advance(300)
    controller.setInactive(true)
    assert.equal(controller.open, false)
    controller.pointerLeaveTrigger()
    controller.pointerEnterTrigger()
    clock.advance(1_000)
    assert.equal(controller.open, false)
    controller.dispose()
  })
})

void describe('HoverCard placement', () => {
  const base = { anchorTop: 400, anchorBottom: 430, sideOffset: 6, viewportHeight: 800 }

  void test('uses the preferred side when the card fits there', () => {
    assert.deepEqual(resolveHoverCardPlacement({ ...base, preferredSide: 'top', cardHeight: 200 }), {
      side: 'top',
      availableHeight: 386,
    })
  })

  void test('flips to the roomier side when the preferred side is too short', () => {
    assert.deepEqual(
      resolveHoverCardPlacement({ ...base, anchorTop: 60, anchorBottom: 90, preferredSide: 'top', cardHeight: 200 }),
      { side: 'bottom', availableHeight: 696 }
    )
  })

  void test('stays on the preferred side when the other side is even shorter, and keeps a usable minimum height', () => {
    assert.deepEqual(
      resolveHoverCardPlacement({
        anchorTop: 90,
        anchorBottom: 120,
        sideOffset: 6,
        viewportHeight: 180,
        preferredSide: 'top',
        cardHeight: 300,
      }),
      { side: 'top', availableHeight: 96 }
    )
  })
})

void describe('HoverCard arrow', () => {
  void test('keeps the card clear of the arrow: the edge sits the arrow height beyond the tip gap', () => {
    assert.equal(HoverCardArrowSize.height, 6)
    assert.equal(resolveHoverCardEdgeOffset(2), 2 + HoverCardArrowSize.height)
    // 选边与可用高度按气泡边缘算，箭头占住触发元素与气泡之间的空隙。
    assert.deepEqual(
      resolveHoverCardPlacement({
        preferredSide: 'top',
        anchorTop: 400,
        anchorBottom: 430,
        cardHeight: 200,
        sideOffset: resolveHoverCardEdgeOffset(2),
        viewportHeight: 800,
      }),
      { side: 'top', availableHeight: 400 - 8 - 8 }
    )
  })

  void test('points at the middle of a row-wide trigger on either side', () => {
    const base = {
      anchorRect: { left: 100, top: 400, width: 600, height: 30 },
      contentWidth: 600,
      contentHeight: 120,
      viewportWidth: 1200,
      viewportHeight: 800,
      portalOrigin: null,
      widthStrategy: 'anchor' as const,
      align: 'start' as const,
      sideOffset: 8,
      viewportPadding: 8,
    }
    const above = resolvePopoverPosition({ ...base, side: 'top' })
    const below = resolvePopoverPosition({ ...base, side: 'bottom' })

    assert.equal(above.top, 400 - 120 - 8)
    assert.equal(below.top, 430 + 8)
    assert.equal(above.width, 600)
    assert.equal(above.anchorCenterX, 300)
    assert.equal(below.anchorCenterX, 300)
  })

  void test('keeps pointing at the trigger when the viewport pushes the card sideways', () => {
    const position = resolvePopoverPosition({
      anchorRect: { left: 1100, top: 400, width: 60, height: 20 },
      contentWidth: 320,
      contentHeight: 100,
      viewportWidth: 1200,
      viewportHeight: 800,
      portalOrigin: null,
      widthStrategy: 'content',
      side: 'top',
      align: 'start',
      sideOffset: 8,
      viewportPadding: 8,
    })

    // 气泡被右侧视口挤回左边，箭头仍对准触发元素中心（样式层再夹到圆角以内）。
    assert.equal(position.left, 1200 - 320 - 8)
    assert.equal(position.anchorCenterX, 1130 - (1200 - 320 - 8))
  })

  void test('draws the arrow outside the scrolling body, in the card fill, flipping with the side', () => {
    const hoverCard = readSource('packages/ui/src/styles/components/primitives/hover-card.css')
    const hoverCardSource = readSource('packages/ui/src/primitives/overlays/HoverCard.tsx')
    const popoverSource = readSource('packages/ui/src/primitives/overlays/Popover.tsx')
    const surface = readRule(hoverCard, '.velar-popover-content.velar-hover-card')
    const body = readRule(hoverCard, '.velar-hover-card-body')
    const arrow = readRule(hoverCard, '.velar-hover-card-arrow')
    const pointingDown = readRule(hoverCard, ".velar-hover-card[data-side='top'] > .velar-hover-card-arrow")
    const pointingUp = readRule(hoverCard, ".velar-hover-card[data-side='bottom'] > .velar-hover-card-arrow")

    // 外层不裁剪（否则箭头被切掉），滚动与限高交给内容层。
    assert.match(surface, /overflow: visible;/)
    assert.doesNotMatch(surface, /^\s*(?:overflow: auto;|max-height:)/mu)
    assert.match(body, /overflow: auto;/)
    assert.match(body, /max-height:\s*min\([\s\S]*?--velar-hover-card-available-height/)
    // 填气泡自己的底色、不描边，横向对准 Popover 写入的触发元素中心并躲开圆角。
    assert.match(arrow, /background-color: inherit;/)
    assert.doesNotMatch(arrow, /\bborder/)
    assert.match(arrow, /left: clamp\([\s\S]*var\(--velar-popover-anchor-center-x, 50%\)/)
    assert.match(arrow, /--velar-hover-card-arrow-inset: calc\(\s*var\(--ui-radius-panel\)/)
    // 气泡在上：箭头挂底边、尖朝下；翻到下方：挂顶边、尖朝上。
    assert.match(pointingDown, /top: calc\(100% - 1px\);/)
    assert.match(pointingDown, /clip-path: polygon\([^)]*50% 100%/)
    assert.match(pointingUp, /bottom: calc\(100% - 1px\);/)
    assert.match(pointingUp, /clip-path: polygon\(50% 0,/)
    // 组件：内容层与箭头是兄弟节点，方向随所选一侧写到 data-side；Popover 写出触发元素中心。
    assert.match(hoverCardSource, /<div className="velar-hover-card-body">\{children\}<\/div>\s*<span className="velar-hover-card-arrow" aria-hidden="true" \/>/)
    assert.match(hoverCardSource, /data-side=\{resolvedSide\}/)
    assert.match(hoverCardSource, /sideOffset=\{edgeOffset\}/)
    assert.match(popoverSource, /'--velar-popover-anchor-center-x'/)
  })
})

void describe('HoverCard markup and CompactToolRow wiring', () => {
  void test('renders only the trigger while closed', () => {
    const markup = renderToStaticMarkup(
      <HoverCard content="执行了 replace_text">
        <div data-testid="row">row</div>
      </HoverCard>
    )

    assert.equal(markup, '<div data-testid="row">row</div>')
  })

  void test('a row with hover details is focusable and drops its native titles', () => {
    const markup = renderToStaticMarkup(
      <CompactToolRow
        icon={null}
        label="project:run"
        detail="bun run check"
        detailTitle="bun run check"
        count="21秒 · ×3"
        countTitle="21秒"
        title="project:run bun run check ×3"
        hoverContent={<span>details</span>}
      />
    )

    assert.match(markup, /tabindex="0"/)
    assert.doesNotMatch(markup, /title=/)
    assert.match(markup, /aria-label="bun run check"/)
  })

  void test('a row without hover details keeps its native titles and stays out of the tab order', () => {
    const markup = renderToStaticMarkup(
      <CompactToolRow
        icon={null}
        label="project:read"
        detail="src/a.ts"
        count="1秒"
        countTitle="1秒"
        title="project:read src/a.ts"
      />
    )

    assert.doesNotMatch(markup, /tabindex/)
    assert.match(markup, /title="project:read src\/a\.ts"/)
    assert.match(markup, /title="1秒"/)
  })

  void test('ships the hover card surface in the global stylesheet and a focus ring for rows', () => {
    const read = (relative: string): string =>
      readFileSync(path.resolve(process.cwd(), relative), 'utf8')
    const index = read('packages/ui/src/styles/components/index.css')
    const hoverCard = read('packages/ui/src/styles/components/primitives/hover-card.css')
    const product = read('packages/ui/src/styles/components/product.css')

    // 叠在 Popover 表面之上，必须排在 popover.css 之后才能覆盖同优先级的规则。
    assert.ok(index.indexOf("'./primitives/hover-card.css'") > index.indexOf("'./primitives/popover.css'"))
    assert.match(hoverCard, /\.velar-popover-content\.velar-hover-card\s*\{[\s\S]*?user-select: text;/)
    assert.match(hoverCard, /max-height:\s*min\([\s\S]*?--velar-hover-card-available-height/)
    assert.match(hoverCard, /overflow: auto;/)
    assert.match(product, /\.velar-compact-tool-row:focus-visible\s*\{/)
  })

  void test('draws neither the tool row nor its bubble with a border, and sizes the bubble to the row', () => {
    const read = (relative: string): string =>
      readFileSync(path.resolve(process.cwd(), relative), 'utf8')
    const hoverCard = read('packages/ui/src/styles/components/primitives/hover-card.css')
    const product = read('packages/ui/src/styles/components/product.css')
    const compactRow = read('packages/ui/src/product/layout/CompactToolRow.tsx')
    const rowRules = [...product.matchAll(/\.velar-compact-tool-row[^{]*\{[^}]*\}/gu)].map(([rule]) => rule)

    assert.match(hoverCard, /\.velar-popover-content\.velar-hover-card\s*\{[^}]*\bborder: 0;/)
    assert.ok(rowRules.length > 0)
    for (const rule of rowRules) {
      // 只允许把边框清零；任何真正画出线的边框或 1px 内描边都不行。
      assert.doesNotMatch(rule, /\bborder(?:-width|-style|-color)?:(?!\s*(?:0|none);)/u, rule)
      assert.doesNotMatch(rule, /inset 0 0 0 1px/u, rule)
    }
    // 没接详情的行，截断全文也走同一个与行等宽、不描边的 HoverCard，正文任意处折行。
    assert.match(
      product,
      /\.velar-compact-tool-row-detail-full\s*\{[^}]*overflow-wrap: anywhere;/
    )
    assert.doesNotMatch(product, /velar-compact-tool-row-detail-tooltip/)
    assert.doesNotMatch(compactRow, /BubbleTooltip/)
    assert.match(
      hoverCard,
      /\[data-width-strategy='anchor'\]\s*\{[^}]*width: var\(--velar-hover-card-anchor-width/
    )
    assert.match(compactRow, /<HoverCard content=\{bubbleContent\} widthStrategy="anchor">/)
  })

  void test('is published as its own subpath like the other overlay primitives', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'packages/ui/package.json'), 'utf8')
    ) as { exports: Record<string, unknown> }
    const rootIndex = readFileSync(path.resolve(process.cwd(), 'packages/ui/src/index.ts'), 'utf8')

    assert.deepEqual(manifest.exports['./primitives/overlays/HoverCard'], {
      types: './dist/primitives/overlays/HoverCard.d.ts',
      import: './dist/primitives/overlays/HoverCard.js',
    })
    assert.match(rootIndex, /export \* from "\.\/primitives\/overlays\/HoverCard";/)
  })
})
