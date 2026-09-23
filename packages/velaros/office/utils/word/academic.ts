/** 学术模板：判定、封面与前言（目录、摘要、关键词）、论文样式与页脚。 */

import {
  AlignmentType,
  type FileChild,
  Footer,
  LineRuleType,
  PageNumber,
  Paragraph,
  TableOfContents,
  TextRun,
} from 'docx'

import { isEmpty, isNonBlankString } from '@velaros-ai/core'

import type {
  OfficeWordInput,
  WordDocumentLanguage,
  WordDocumentProfile,
} from '../../types/office.js'
import type { WordAcademicLabels } from '../../types/word.js'

import { resolveWordFontFamilies } from './fonts.js'

/** 走学术排版（封面、目录、摘要、页码）的两个模板。 */
const WordAcademicProfiles = new Set<WordDocumentProfile>(['academic-paper', 'thesis'])

/** 中英两套封面与前言标签；同一份文档只用其中一套。 */
const WordAcademicLabelsByLanguage: Record<WordDocumentLanguage, WordAcademicLabels> = {
  'en-US': {
    toc: 'Contents',
    abstract: 'Abstract',
    keywords: 'Keywords',
    author: 'Author',
    advisor: 'Advisor',
    school: 'School',
    department: 'Department',
    major: 'Major',
    course: 'Course',
    className: 'Class',
    studentId: 'Student ID',
    date: 'Date',
    organization: 'Organization',
  },
  'zh-CN': {
    toc: '目录',
    abstract: '摘要',
    keywords: '关键词',
    author: '作者',
    advisor: '指导教师',
    school: '学校',
    department: '院系',
    major: '专业',
    course: '课程',
    className: '班级',
    studentId: '学号',
    date: '日期',
    organization: '单位',
  },
}

/** 判断是不是学术排版模板。 */
export function isAcademicWordProfile(profile?: WordDocumentProfile): boolean {
  return !!profile && WordAcademicProfiles.has(profile)
}

/** 判断这次生成要不要插入目录域。 */
export function shouldIncludeAcademicToc(
  input: Pick<OfficeWordInput, 'profile' | 'includeTableOfContents'>
): boolean {
  return isAcademicWordProfile(input.profile) && (input.includeTableOfContents ?? true)
}

/** 取文档语言，没给就按中文。 */
export function getWordLanguage(input: Pick<OfficeWordInput, 'language'>): WordDocumentLanguage {
  return input.language ?? 'zh-CN'
}

/** 构建学术文档的封面与前言：标题、副标题、元数据行、目录、摘要与关键词。 */
export function buildAcademicWordFrontMatter(
  children: FileChild[],
  input: Pick<
    OfficeWordInput,
    | 'title'
    | 'author'
    | 'profile'
    | 'language'
    | 'metadata'
    | 'abstract'
    | 'keywords'
    | 'includeTableOfContents'
  >
): void {
  const language = getWordLanguage(input)
  const fonts = resolveWordFontFamilies(language)
  const labels = WordAcademicLabelsByLanguage[language]
  const metadataRows = buildAcademicMetadataRows(input, labels)
  const hasCoverContent = !!input.title || !!input.metadata?.subtitle || !isEmpty(metadataRows)

  if (input.title) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 1_360, after: 220, line: 360, lineRule: LineRuleType.AUTO },
        children: [
          new TextRun({
            text: input.title,
            bold: true,
            size: language === 'en-US' ? 36 : 40,
            font: { ascii: fonts.heading, hAnsi: fonts.heading, eastAsia: fonts.heading },
          }),
        ],
      })
    )
  }

  if (input.metadata?.subtitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 520 },
        children: [
          new TextRun({
            text: input.metadata.subtitle,
            size: 24,
            color: '475569',
          }),
        ],
      })
    )
  }

  for (const row of metadataRows) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 80 },
        children: [new TextRun({ text: row, size: 24 })],
      })
    )
  }

  if (
    hasCoverContent &&
    (shouldIncludeAcademicToc(input) ||
      input.abstract ||
      (!!input.keywords && !isEmpty(input.keywords)))
  ) {
    children.push(new Paragraph({ text: '', pageBreakBefore: true }))
  }

  if (shouldIncludeAcademicToc(input)) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 160, after: 240 },
        children: [new TextRun({ text: labels.toc, bold: true, size: 30 })],
      })
    )
    children.push(
      new TableOfContents(labels.toc, {
        hyperlink: true,
        headingStyleRange: '1-3',
        beginDirty: true,
      })
    )
    if (input.abstract || (!!input.keywords && !isEmpty(input.keywords))) {
      children.push(new Paragraph({ text: '', pageBreakBefore: true }))
    }
  }

  if (input.abstract || (!!input.keywords && !isEmpty(input.keywords))) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: labels.abstract, bold: true, size: 28 })],
      })
    )
    if (input.abstract) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.BOTH,
          spacing: { after: 180, line: 360, lineRule: LineRuleType.AUTO },
          children: [new TextRun({ text: input.abstract, size: 24 })],
        })
      )
    }
    if (!!input.keywords && !isEmpty(input.keywords)) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.BOTH,
          spacing: { after: 260 },
          children: [
            new TextRun({ text: `${labels.keywords}: `, bold: true, size: 24 }),
            new TextRun({
              text: input.keywords.join(language === 'en-US' ? '; ' : '；'),
              size: 24,
            }),
          ],
        })
      )
    }
    children.push(new Paragraph({ text: '', pageBreakBefore: true }))
  }
}

/** 把封面上的学校、院系、作者、日期这些字段排成「标签: 值」的行。 */
export function buildAcademicMetadataRows(
  input: Pick<OfficeWordInput, 'author' | 'metadata'>,
  labels: WordAcademicLabels
): string[] {
  const metadata = input.metadata ?? {}
  const pairs: Array<[string, string | undefined]> = [
    [labels.school, metadata.school],
    [labels.organization, metadata.organization],
    [labels.department, metadata.department],
    [labels.major, metadata.major],
    [labels.course, metadata.course],
    [labels.className, metadata.className],
    [labels.studentId, metadata.studentId],
    [labels.author, input.author],
    [labels.advisor, metadata.advisor],
    [labels.date, metadata.date],
  ]

  return pairs
    .filter(([, value]) => isNonBlankString(value))
    .map(([label, value]) => `${label}: ${value?.trim()}`)
}

/** 学术模板的样式表：正文、标题、摘要与参考文献段落样式。 */
export function buildAcademicWordStyles(language: WordDocumentLanguage) {
  const { body: bodyFont, heading: headingFont } = resolveWordFontFamilies(language)

  return {
    default: {
      document: {
        run: { font: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, size: 24 },
        paragraph: {
          spacing: { after: 160, line: 360, lineRule: LineRuleType.AUTO },
          alignment: AlignmentType.BOTH,
        },
      },
      title: {
        run: { font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont }, size: 40 },
        paragraph: { spacing: { after: 320 }, alignment: AlignmentType.CENTER },
      },
      heading1: {
        run: {
          bold: true,
          size: 30,
          color: '0F172A',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 280, after: 180 }, outlineLevel: 0 },
      },
      heading2: {
        run: {
          bold: true,
          size: 26,
          color: '1E293B',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 220, after: 140 }, outlineLevel: 1 },
      },
      heading3: {
        run: {
          bold: true,
          size: 24,
          color: '334155',
          font: { ascii: headingFont, hAnsi: headingFont, eastAsia: headingFont },
        },
        paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 2 },
      },
    },
    paragraphStyles: [
      {
        id: 'Abstract',
        name: 'Abstract',
        basedOn: 'Normal',
        run: { font: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, size: 22 },
        paragraph: { spacing: { after: 120, line: 320, lineRule: LineRuleType.AUTO } },
      },
      {
        id: 'Bibliography',
        name: 'Bibliography',
        basedOn: 'Normal',
        run: { font: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, size: 22 },
        paragraph: { spacing: { after: 80 }, indent: { hanging: 360 } },
      },
    ],
  }
}

/** 学术模板的页脚：居中页码。 */
export function buildAcademicWordFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            children: [PageNumber.CURRENT],
            size: 18,
            color: '64748B',
          }),
        ],
      }),
    ],
  })
}
