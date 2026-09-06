import { describe, expect, test } from 'bun:test'
import JSZip from 'jszip'

import PptxGenJS from '../vendor/pptxgenjs/pptxgen.es.js'

describe('vendored PptxGenJS runtime', () => {
  test('creates a readable presentation without the removed image parser dependency', async () => {
    const presentation = new PptxGenJS()
    presentation.layout = 'LAYOUT_WIDE'
    presentation.addSlide().addText('VelarOS', { x: 1, y: 1, w: 4, h: 1 })

    const archive = await presentation.write({ outputType: 'arraybuffer' })
    const zip = await JSZip.loadAsync(archive)

    expect(zip.file('[Content_Types].xml')).not.toBeNull()
    expect(zip.file('ppt/presentation.xml')).not.toBeNull()
    expect(zip.file('ppt/slides/slide1.xml')).not.toBeNull()
  })
})
