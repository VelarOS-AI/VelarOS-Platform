/** 四套自动排版模板：配色、封面页与内容页版式、卡片网格、主题字体。 */

import { isEmpty } from '@velaros-ai/core'

import type { PptElement, PresentationSlideInput, PresentationTemplate } from '../../types/office.js'
import type { PptxTheme } from '../../types/pptx.js'
import type { PresentationTemplatePalette } from '../../types/presentation.js'
import { OfficeTuning } from '../tuning.js'

/** 每套模板的配色与字体；改观感就改这张表。 */
const PresentationTemplatePalettes: Record<PresentationTemplate, PresentationTemplatePalette> = {
  modern: {
    background: 'F8FAFC',
    surface: 'FFFFFF',
    primary: '0F172A',
    secondary: '1D4ED8',
    accent: '14B8A6',
    accentSoft: 'CCFBF1',
    text: '111827',
    muted: '64748B',
    titleFont: 'Aptos Display',
    bodyFont: 'Aptos',
  },
  consulting: {
    background: 'F7F7F5',
    surface: 'FFFFFF',
    primary: '172554',
    secondary: '0F766E',
    accent: 'EAB308',
    accentSoft: 'FEF3C7',
    text: '111827',
    muted: '6B7280',
    titleFont: 'Aptos Display',
    bodyFont: 'Aptos',
  },
  academic: {
    background: 'F8FAFC',
    surface: 'FFFFFF',
    primary: '1E293B',
    secondary: '0F766E',
    accent: '2563EB',
    accentSoft: 'DBEAFE',
    text: '111827',
    muted: '64748B',
    titleFont: 'Times New Roman',
    bodyFont: 'Aptos',
  },
  minimal: {
    background: 'FFFFFF',
    surface: 'F8FAFC',
    primary: '111827',
    secondary: '475569',
    accent: 'DC2626',
    accentSoft: 'FEE2E2',
    text: '111827',
    muted: '71717A',
    titleFont: 'Aptos Display',
    bodyFont: 'Aptos',
  },
}

/** 按模板版式排一页：第一页是封面，其余页按卡片网格或整块正文排。 */
export function buildTemplatePresentationSlide(input: {
  title: string
  body: string
  index: number
  template: PresentationTemplate
  isTitleSlide: boolean
}): PresentationSlideInput {
  const palette = PresentationTemplatePalettes[input.template]
  const slideWidth = OfficeTuning.presentation.slideWidthInches
  const slideHeight = OfficeTuning.presentation.slideHeightInches
  const bodyLines = input.body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const bullets = bodyLines
    .map((line) => line.replace(/^•\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8)

  if (input.isTitleSlide) return {
      background: { color: palette.primary },
      elements: [
        {
          kind: 'shape',
          shape: 'rect',
          x: 0,
          y: 0,
          w: slideWidth,
          h: slideHeight,
          options: { fill: { color: palette.primary }, line: { color: palette.primary } },
        },
        {
          kind: 'shape',
          shape: 'rect',
          x: 0,
          y: 6.95,
          w: slideWidth,
          h: 0.55,
          options: { fill: { color: palette.accent }, line: { color: palette.accent } },
        },
        {
          kind: 'shape',
          shape: 'rect',
          x: 0.72,
          y: 0.72,
          w: 0.12,
          h: 4.4,
          options: { fill: { color: palette.accent }, line: { color: palette.accent } },
        },
        {
          kind: 'text',
          value: input.title,
          x: 1.05,
          y: 1.05,
          w: 10.9,
          h: 1.35,
          options: {
            fontFace: palette.titleFont,
            fontSize: input.template === 'academic' ? 34 : 40,
            bold: true,
            color: 'FFFFFF',
            margin: 0,
            fit: 'shrink' as const,
            breakLine: false,
          },
        },
        ...(!isEmpty(bodyLines)
          ? [
              {
                kind: 'text' as const,
                value: bodyLines.slice(0, 4).join('\n'),
                x: 1.08,
                y: 2.75,
                w: 8.8,
                h: 1.65,
                options: {
                  fontFace: palette.bodyFont,
                  fontSize: 18,
                  color: 'E2E8F0',
                  breakLine: false,
                  fit: 'shrink' as const,
                  valign: 'top' as const,
                },
              },
            ]
          : []),
      ],
    }

  const elements: PptElement[] = [
    {
      kind: 'shape',
      shape: 'rect',
      x: 0,
      y: 0,
      w: slideWidth,
      h: slideHeight,
      options: { fill: { color: palette.background }, line: { color: palette.background } },
    },
    {
      kind: 'shape',
      shape: 'rect',
      x: 0,
      y: 0,
      w: 0.18,
      h: slideHeight,
      options: { fill: { color: palette.accent }, line: { color: palette.accent } },
    },
    {
      kind: 'text',
      value: input.title,
      x: 0.72,
      y: 0.44,
      w: 11.7,
      h: 0.72,
      options: {
        fontFace: palette.titleFont,
        fontSize: input.template === 'academic' ? 25 : 28,
        bold: true,
        color: palette.primary,
        margin: 0,
        fit: 'shrink' as const,
        breakLine: false,
      },
    },
    {
      kind: 'shape',
      shape: 'rect',
      x: 0.72,
      y: 1.27,
      w: 2.35,
      h: 0.05,
      options: { fill: { color: palette.accent }, line: { color: palette.accent } },
    },
  ]

  if (bullets.length >= 2 && bullets.length <= 6) {
    elements.push(...buildPresentationCardGrid(bullets, palette))
  } else if (input.body) {
    elements.push({
      kind: 'shape',
      shape: 'roundRect',
      x: 0.72,
      y: 1.65,
      w: 11.78,
      h: 4.95,
      options: {
        fill: { color: palette.surface },
        line: {
          color: input.template === 'minimal' ? 'E5E7EB' : palette.accentSoft,
          transparency: 8,
        },
      },
    })
    elements.push({
      kind: 'text',
      value: input.body,
      x: 1.0,
      y: 1.92,
      w: 11.2,
      h: 4.3,
      options: {
        fontFace: palette.bodyFont,
        fontSize: input.template === 'academic' ? 16 : 18,
        color: palette.text,
        valign: 'top' as const,
        fit: 'shrink' as const,
        breakLine: false,
        margin: 0.02,
      },
    })
  }

  elements.push(
    {
      kind: 'text',
      value: `${input.index + 1}`.padStart(2, '0'),
      x: 11.78,
      y: 6.86,
      w: 0.7,
      h: 0.22,
      options: {
        fontFace: palette.bodyFont,
        fontSize: 9,
        color: palette.muted,
        align: 'right' as const,
        margin: 0,
      },
    },
    {
      kind: 'shape',
      shape: 'rect',
      x: 0.72,
      y: 6.97,
      w: 10.8,
      h: 0.02,
      options: { fill: { color: 'CBD5E1', transparency: 20 }, line: { color: 'CBD5E1' } },
    }
  )

  return {
    background: { color: palette.background },
    elements,
  }
}

/** 把两到六条要点排成卡片网格。 */
export function buildPresentationCardGrid(
  bullets: string[],
  palette: PresentationTemplatePalette
): PptElement[] {
  const elements: PptElement[] = []
  const columns = bullets.length <= 3 ? bullets.length : 2
  const rows = Math.ceil(bullets.length / columns)
  const gap = 0.25
  const startX = 0.72
  const startY = 1.7
  const totalW = 11.78
  const totalH = 4.9
  const cardW = (totalW - gap * (columns - 1)) / columns
  const cardH = Math.min(1.55, (totalH - gap * (rows - 1)) / rows)

  bullets.forEach((item, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    const x = startX + col * (cardW + gap)
    const y = startY + row * (cardH + gap)
    const markerColor = index % 2 === 0 ? palette.accent : palette.secondary

    elements.push(
      {
        kind: 'shape',
        shape: 'roundRect',
        x,
        y,
        w: cardW,
        h: cardH,
        options: {
          fill: { color: palette.surface },
          line: { color: palette.accentSoft },
        },
      },
      {
        kind: 'shape',
        shape: 'rect',
        x,
        y,
        w: 0.08,
        h: cardH,
        options: { fill: { color: markerColor }, line: { color: markerColor } },
      },
      {
        kind: 'text',
        value: item,
        x: x + 0.28,
        y: y + 0.18,
        w: cardW - 0.48,
        h: cardH - 0.32,
        options: {
          fontFace: palette.bodyFont,
          fontSize: 16,
          bold: index < 3,
          color: palette.text,
          fit: 'shrink' as const,
          valign: 'middle' as const,
          margin: 0,
          breakLine: false,
        },
      }
    )
  })

  return elements
}

/** 取一套模板对应的 pptxgenjs 主题（标题与正文字体）。 */
export function buildPresentationTheme(template: PresentationTemplate): PptxTheme {
  const palette = PresentationTemplatePalettes[template]
  return {
    headFontFace: palette.titleFont,
    bodyFontFace: palette.bodyFont,
  }
}
