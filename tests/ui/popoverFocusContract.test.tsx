import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '../../packages/ui/src/primitives/overlays/Popover'

void describe('Popover focus ownership', () => {
  void test('accepts owner-selected focus callbacks without running them during closed rendering', () => {
    const focusEvents: string[] = []
    const markup = renderToStaticMarkup(
      <Popover open={false} onOpenChange={() => undefined}>
        <PopoverAnchor asChild>
          <button type="button" aria-expanded={false}>Branches</button>
        </PopoverAnchor>
        <PopoverContent
          onOpenAutoFocus={(event) => focusEvents.push(event.type)}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <input aria-label="Search branches" />
        </PopoverContent>
      </Popover>
    )

    assert.deepEqual(focusEvents, [])
    assert.match(markup, /<button[^>]+aria-expanded="false"/)
    assert.doesNotMatch(markup, /Search branches|onOpenAutoFocus|onCloseAutoFocus/)
  })

  void test('keeps focus selection with the owner and forwards that contract through anchored popovers', () => {
    const popover = readFileSync(
      path.resolve(process.cwd(), 'packages/ui/src/primitives/overlays/Popover.tsx'),
      'utf8'
    )
    const anchored = readFileSync(
      path.resolve(process.cwd(), 'packages/ui/src/primitives/overlays/AnchoredPopover.tsx'),
      'utf8'
    )

    assert.match(popover, /onOpenAutoFocus\?: \(event: Event\) => void/)
    assert.doesNotMatch(popover, /querySelector(?:<[^>]+>)?\(['"](?:input|\[autofocus\])/)
    assert.match(anchored, /type PopoverContentProps = ComponentPropsWithoutRef<typeof PopoverContent>/)
    assert.match(anchored, /AnchoredPopoverProps extends Omit<PopoverContentProps, 'children'>/)
    assert.match(anchored, /<PopoverContent\s+\{\.\.\.contentProps\}/)
  })
})
