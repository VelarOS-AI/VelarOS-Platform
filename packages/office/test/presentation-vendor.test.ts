import { describe, expect, test } from 'bun:test'
import JSZip from 'jszip'

import PptxGenJS from '../vendor/pptxgenjs/pptxgen.es.js'

describe('vendored PptxGenJS runtime', () => {
  test('creates a readable presentation without the removed image parser dependency', async () => {
    const presentation = new PptxGenJS()
    presentation.layout = 'LAYOUT_WIDE'
    const slide = presentation.addSlide()
    slide.addText('VelarOS', { x: 1, y: 1, w: 4, h: 1 })
    slide.addImage({
      data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      x: 1,
      y: 2,
      w: 1,
      h: 1,
    })

    const archive = await presentation.write({ outputType: 'arraybuffer' })
    const zip = await JSZip.loadAsync(archive)

    expect(zip.file('[Content_Types].xml')).not.toBeNull()
    expect(zip.file('ppt/presentation.xml')).not.toBeNull()
    expect(zip.file('ppt/slides/slide1.xml')).not.toBeNull()
    expect(zip.file('ppt/media/image-1-1.png')).not.toBeNull()
    expect(zip.files['../media/image-1-1.png']).toBeUndefined()
  })
})
