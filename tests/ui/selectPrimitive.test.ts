import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

void describe('Select primitive', () => {
  void test('owns searchable long-list presentation', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'packages/ui/src/primitives/forms/Select.tsx'),
      'utf8'
    )

    assert.match(source, /searchable\?: boolean/)
    assert.match(source, /<SearchField/)
    assert.match(source, /visibleOptions\.map/)
    assert.match(source, /role="status"/)
  })

  void test('keeps the search fixed above an explicitly scrollable option viewport', () => {
    const styles = readFileSync(
      path.resolve(process.cwd(), 'packages/ui/src/styles/components/primitives/select.css'),
      'utf8'
    )

    assert.match(styles, /\.velar-select-content[\s\S]*display:\s*flex/)
    assert.match(styles, /\.velar-select-search[\s\S]*flex-shrink:\s*0/)
    assert.match(styles, /\.velar-select-viewport[\s\S]*overflow-y:\s*auto/)
    assert.match(styles, /scrollbar-gutter:\s*stable/)
    assert.match(styles, /\.velar-select-viewport::-webkit-scrollbar-thumb/)
  })
})
