import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SearchField } from '../../packages/ui/src/primitives/forms/SearchField'

void describe('SearchField primitive', () => {
  void test('owns the shared search semantics and input shell', () => {
    const markup = renderToStaticMarkup(<SearchField aria-label="Search files" value="query" readOnly />)

    assert.match(markup, /data-slot="search-field"/)
    assert.match(markup, /type="search"/)
    assert.match(markup, /velar-search-field-input/)
  })

  void test('keeps the input transparent and focuses the complete field', () => {
    const styles = readFileSync(
      path.resolve(
        process.cwd(),
        'packages/ui/src/styles/components/primitives/search-field.css'
      ),
      'utf8'
    )

    assert.match(styles, /\.velar-search-field:focus-within/)
    assert.match(styles, /\.velar-search-field \.velar-search-field-input[\s\S]*background:\s*transparent/)
    assert.match(styles, /\.velar-search-field \.velar-search-field-input:focus[\s\S]*box-shadow:\s*none/)
  })
})
