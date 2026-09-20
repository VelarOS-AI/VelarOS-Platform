/** PPT 内容归一化：把 Markdown/纯文本按标题与 --- 拆成幻灯片。 */

import { isArray, isEmpty, isString, optionalWhen } from '@velaros-ai/core'

import { OfficeInputLimits } from '../../contract/constants.js'
import type { OfficePresentationInput, PresentationSlideInput, PresentationTemplate } from '../../types/office.js'
import { OfficeTuning } from '../tuning.js'

import { buildTemplatePresentationSlide } from './templates.js'

/** 将输入统一转成 PresentationSlideInput 列表。 */
export function normalizePresentationSlides(input: OfficePresentationInput): PresentationSlideInput[] {
  if (isArray(input.slides)) return input.slides
  return isString(input.content) ? parsePresentationContentToSlides(input.content, input.title, input.template ?? 'modern') : []
}

/** 把 Markdown/纯文本拆成简单标题+正文幻灯片。 */
export function parsePresentationContentToSlides(
  content: string,
  deckTitle?: string,
  template: PresentationTemplate = 'modern'
): PresentationSlideInput[] {
  const sections = splitPresentationContent(content).slice(0, OfficeInputLimits.presentation.slides)
  return sections
    .map((section, index) => buildPresentationSlideFromLines(section, index, deckTitle, template))
    .filter((slide) => !isEmpty(slide.elements))
}

/** 按 Markdown 一级标题或 --- 分隔内容块。 */
export function splitPresentationContent(content: string): string[][] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const sections: string[][] = []
  let current: string[] = []
  // flush 会跳过全空 section。
  const flush = (): void => {
    if (current.some((line) => line.trim())) sections.push(current)
    current = []
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^-{3,}$/.test(trimmed)) {
      flush()
      continue
    }
    // 新的一级标题会开启下一页。
    if (/^#\s+/.test(trimmed) && current.some((entry) => entry.trim())) flush()
    current.push(line)
  }
  flush()
  return sections
}

/** 将一个文本 section 转成默认版式幻灯片。 */
export function buildPresentationSlideFromLines(
  lines: string[],
  index: number,
  deckTitle?: string,
  template: PresentationTemplate = 'modern'
): PresentationSlideInput {
  let slideTitle = optionalWhen((index === 0), deckTitle)
  const bodyLines: string[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading?.[1]) {
      // 第一条 heading 作为页标题，后续 heading 退化为正文行。
      if (!slideTitle) {
        slideTitle = heading[1].trim()
      } else {
        bodyLines.push(heading[1].trim())
      }
      continue
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/)
    bodyLines.push(bullet?.[1] ? `• ${bullet[1].trim()}` : line)
  }
  const title = (slideTitle || bodyLines.shift() || `第 ${index + 1} 页`).slice(
    0,
    OfficeInputLimits.shortFieldChars
  )
  // 自动模式限制单页正文长度，避免文字溢出幻灯片。
  const body = bodyLines.join('\n').slice(0, OfficeTuning.presentation.slideBodyChars)
  return buildTemplatePresentationSlide({
    title,
    body,
    index,
    template,
    isTitleSlide: index === 0,
  })
}
