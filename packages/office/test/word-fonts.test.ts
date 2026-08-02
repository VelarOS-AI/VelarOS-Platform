import { describe, expect, test } from 'bun:test'
import { Packer } from 'docx'
import JSZip from 'jszip'

import { buildMacLibreOfficeFontConfig } from '../src/officeShared'
import {
  buildWordDocument,
  resolveWordFontFamilies,
} from '../src/wordTool'

describe('Word document font portability', () => {
  test('selects a native CJK family for each supported host platform', () => {
    expect(resolveWordFontFamilies('zh-CN', 'darwin')).toEqual({
      body: 'Arial Unicode MS',
      heading: 'Arial Unicode MS',
    })
    expect(resolveWordFontFamilies('zh-CN', 'win32')).toEqual({
      body: 'Microsoft YaHei',
      heading: 'Microsoft YaHei',
    })
    expect(resolveWordFontFamilies('zh-CN', 'linux')).toEqual({
      body: 'Noto Sans CJK SC',
      heading: 'Noto Sans CJK SC',
    })
  })

  test('builds a relocatable macOS font configuration with a writable cache', () => {
    const config = buildMacLibreOfficeFontConfig({
      homeDir: '/Users/example & partner',
      cacheDir: '/private/tmp/font cache',
    })
    expect(config).toContain('<dir>/System/Library/Fonts</dir>')
    expect(config).toContain('<dir>/Users/example &amp; partner/Library/Fonts</dir>')
    expect(config).toContain('<cachedir>/private/tmp/font cache</cachedir>')
  })

  test('writes explicit CJK fonts into a standard document style sheet', async () => {
    const document = buildWordDocument({
      title: '产品与工程周报',
      profile: 'standard',
      language: 'zh-CN',
      metadata: { subtitle: 'Host 网页链路实测', date: '2026-08-01' },
      blocks: [{ kind: 'paragraph', text: '本周摘要与下周计划。' }],
    })
    const archive = await JSZip.loadAsync(await Packer.toBuffer(document))
    const stylesXml = await archive.file('word/styles.xml')?.async('text')
    expect(stylesXml).toContain('<w:docDefaults>')
    expect(stylesXml).toContain(`w:eastAsia="${resolveWordFontFamilies('zh-CN').body}"`)
    expect(stylesXml).toContain('w:styleId="Title"')
  })
})
