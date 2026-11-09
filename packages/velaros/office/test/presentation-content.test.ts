import assert from 'node:assert/strict'

import { expect, test } from 'bun:test'

import { OfficeInputLimits } from '../contract/constants.js'
import { parsePresentationContentToSlides } from '../utils/presentation/content.js'

test('自动演示保留长标题和封面全部正文，超限明确拒绝而不裁剪', () => {
  const title = '题'.repeat(OfficeInputLimits.titleChars)
  const body = Array.from({ length: 6 }, (_, index) => `完整正文 ${index + 1}`)
  const slides = parsePresentationContentToSlides(`# ${title}\n${body.join('\n')}`)
  const text = slides[0].elements
    .filter((element) => element.kind === 'text')
    .map((element) => element.value)
    .join('\n')
  expect(text).toContain(title)
  for (const line of body) expect(text).toContain(line)
  for (const content of [
    `# ${title}多一个`,
    `# 标题\n${'x'.repeat(OfficeInputLimits.presentation.autoBodyChars + 1)}`,
    Array.from(
      { length: OfficeInputLimits.presentation.slides + 1 },
      (_, index) => `# 第 ${index + 1} 页`
    ).join('\n'),
  ])
    assert.throws(() => parsePresentationContentToSlides(content), { code: 'VALIDATION' })
})
