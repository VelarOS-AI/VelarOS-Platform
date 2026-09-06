import { describe, expect, test } from 'bun:test'

import { tokenizeHtmlArtifactSource } from '../src/conversation/artifacts/htmlArtifactCodeTokenizer'
import {
  type DiffCodeLanguage,
  tokenizeDiffCodeLine,
} from '../src/conversation/cards/fileChangeDiffHighlight'

describe('conversation code tokenizers', () => {
  test('preserves each diff line exactly across language scanners', () => {
    const samples: Array<[DiffCodeLanguage, string]> = [
      ['javascript', 'const value = `hello ${name}`; // comment'],
      ['json', '{"value": -12.5e+2, "ok": true}'],
      ['css', '.card:hover { color: #aabbcc; width: 12.5rem; }'],
      ['markup', '<article data-id="x"><!-- note --></article>'],
      ['shell', 'printf "%s" "$VALUE" && echo done # note'],
    ]

    for (const [language, source] of samples) {
      expect(tokenizeDiffCodeLine(source, language).map((token) => token.text).join('')).toBe(source)
    }
  })

  test('scans adversarial repeated prefixes without regular-expression backtracking', () => {
    const source = `${'<!--'.repeat(20_000)}tail`
    expect(tokenizeDiffCodeLine(source, 'markup').map((token) => token.text).join('')).toBe(source)
  })

  test('keeps adjacent JavaScript operators and member access outside number tokens', () => {
    const source = 'const values = [1+2, 1-2, 10..toString()]'
    const tokens = tokenizeDiffCodeLine(source, 'javascript')

    expect(tokens.map((token) => token.text).join('')).toBe(source)
    expect(tokens.filter((token) => token.kind === 'number').map((token) => token.text)).toEqual([
      '1',
      '2',
      '1',
      '2',
      '10.',
    ])
    expect(tokens.filter((token) => token.kind === 'operator').map((token) => token.text)).toEqual([
      '=',
      '+',
      '-',
    ])
  })

  test('highlights an HTML doctype as a keyword', () => {
    const source = '<!DOCTYPE html>'
    expect(tokenizeDiffCodeLine(source, 'markup')).toEqual([{ kind: 'keyword', text: source }])
  })

  test('keeps complete CSS class and id selectors', () => {
    const source = '.card:hover, #app { color: #aabbcc; }'
    const tokens = tokenizeDiffCodeLine(source, 'css')

    expect(tokens.map((token) => token.text).join('')).toBe(source)
    expect(tokens.find((token) => token.text === '.card')?.kind).toBe('tag')
    expect(tokens.find((token) => token.text === '#app')?.kind).toBe('tag')
    expect(tokens.find((token) => token.text === '#aabbcc')?.kind).toBe('number')
  })

  test('keeps markup namespace names intact', () => {
    const source = '<svg:path xlink:href="#id">'
    expect(tokenizeDiffCodeLine(source, 'markup')).toEqual([
      { kind: 'punctuation', text: '<' },
      { kind: 'tag', text: 'svg:path' },
      { kind: 'plain', text: ' ' },
      { kind: 'attribute', text: 'xlink:href' },
      { kind: 'punctuation', text: '=' },
      { kind: 'string', text: '"#id"' },
      { kind: 'punctuation', text: '>' },
    ])
  })

  test('starts shell comments only at word boundaries', () => {
    const source = 'echo https://example.com/a#frag foo#bar # note'
    expect(tokenizeDiffCodeLine(source, 'shell')).toEqual([
      { kind: 'keyword', text: 'echo' },
      { kind: 'plain', text: ' https://example.com/a#frag foo#bar ' },
      { kind: 'comment', text: '# note' },
    ])
  })

  test('preserves HTML, comments, quoted greater-than signs, and embedded code', () => {
    const source = '<div title="1 > 0"><!-- note --><script>const x = "<tag>";</script></div>'
    expect(tokenizeHtmlArtifactSource(source).map((token) => token.value).join('')).toBe(source)
  })
})
