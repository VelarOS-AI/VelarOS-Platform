import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { Document, ImageRun, Packer, Paragraph } from 'docx'

import {
  decodeHtmlText,
  htmlToText,
  parseDocxPreview,
  sanitizePreviewHtml,
} from '../src/previewTool'

const OnePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

describe('Office preview HTML sanitization', () => {
  test('removes executable elements and attributes after standards-based parsing', () => {
    const sanitized = sanitizePreviewHtml([
      '<p onclick="alert(1)">safe',
      '<scr<script>ipt>alert(2)</scr</script>ipt>',
      '<svg><script>alert(3)</script></svg>',
      '<a href="java&#x0a;script:alert(4)" title="kept">link</a>',
      '<iframe srcdoc="<script>alert(5)</script>"></iframe>',
      '</p>',
    ].join(''))

    expect(sanitized).toContain('<p>safe')
    expect(sanitized).toContain('<a title="kept">link</a>')
    expect(sanitized).not.toMatch(/script|onclick|iframe|svg|javascript/iu)
  })

  test('retains document formatting and only safe link schemes', () => {
    expect(sanitizePreviewHtml(
      '<table class="word"><tr><td colspan="2" style="color:red">Cell</td></tr></table>'
      + '<a href="https://example.com" target="_blank">site</a><a href="#heading">heading</a>'
      + '<a href="../../secret.html">relative</a><a href="/etc/passwd">root</a>'
      + '<a href="//evil.example/share">protocol relative</a>'
      + '<a href="  ">empty</a>'
    )).toBe(
      '<table><tbody><tr><td colspan="2">Cell</td></tr></tbody></table>'
      + '<a href="https://example.com">site</a><a href="#heading">heading</a>'
      + '<a>relative</a><a>root</a><a>protocol relative</a><a>empty</a>'
    )
  })

  test('retains style-map sections and strictly allowlisted raster data images', () => {
    const safePng = `data:image/png;base64,${OnePixelPng.toString('base64')}`
    const sanitized = sanitizePreviewHtml([
      '<p class="subtitle">Subtitle</p>',
      '<section class="abstract"><p>Abstract</p></section>',
      `<img src="${safePng}" alt="safe &amp; useful" title="preview" width="12" height="8192">`,
      '<p class="subtitle injected">No mixed class</p>',
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
      '<img src="https://example.com/a.png"><img src="file:///tmp/a.png"><img src="blob:x">',
      '<img src="data:image/png;base64,AAAAA">',
    ].join(''))

    expect(sanitized).toContain('<p class="subtitle">Subtitle</p>')
    expect(sanitized).toContain('<section class="abstract"><p>Abstract</p></section>')
    expect(sanitized).toContain(`<img src="${safePng}" alt="safe &amp; useful" title="preview" width="12" height="8192">`)
    expect(sanitized).toContain('<p>No mixed class</p>')
    expect(sanitized.match(/<img/gu)).toHaveLength(1)
    expect(sanitized).not.toMatch(/svg|https:|file:|blob:/iu)
  })

  test('keeps Mammoth style-map structure and embedded raster output from a real DOCX', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-office-preview-'))
    const inputPath = join(directory, 'input.docx')
    try {
      const document = new Document({
        styles: {
          paragraphStyles: [
            { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal' },
            { id: 'Abstract', name: 'Abstract', basedOn: 'Normal' },
          ],
        },
        sections: [{
          children: [
            new Paragraph({ text: 'Release subtitle', style: 'Subtitle' }),
            new Paragraph({ text: 'Safety abstract', style: 'Abstract' }),
            new Paragraph({ children: [new ImageRun({
              data: OnePixelPng,
              transformation: { width: 1, height: 1 },
              type: 'png',
            })] }),
          ],
        }],
      })
      await writeFile(inputPath, await Packer.toBuffer(document))

      const preview = await parseDocxPreview(inputPath, 20)
      expect(preview.htmlBody).toContain('<p class="subtitle">Release subtitle</p>')
      expect(preview.htmlBody).toContain('<section class="abstract"><p>Safety abstract</p></section>')
      expect(preview.htmlBody).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/]+=*">/u)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('extracts text without a tag-matching regular expression', () => {
    expect(htmlToText('<h1>Title &amp; notes</h1><p>Body</p>')).toMatch(/Title & notes\s+Body/u)
  })

  test('decodes entities exactly once and rejects invalid numeric code points', () => {
    expect(decodeHtmlText('&amp;lt; &#65; &#x1f600; &#x110000;')).toBe('&lt; A 😀 �')
  })
})
