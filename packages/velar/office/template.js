// velar:office 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 路径相对当前空间的工作区根；目标文件已经在时要传 overwrite: true 才覆盖。
import { createPresentation, createSpreadsheet, createWord, editPdf, latexToPdf, preview, readPdf, toMarkdown, wordToPdf } from 'velar:office'

// 写一份 Word 报告：正文用 Markdown，标题、列表、表格自动排好。
async function report(outputPath = 'reports/weekly.docx') {
  const written = await createWord({
    outputPath,
    title: '周报',
    content: '# 本周进展\n\n- 完成登录改版\n- 推进支付接入\n\n| 指标 | 数值 |\n| --- | --- |\n| 日活 | 1200 |',
    overwrite: true,
  })
  return written.path
}

// 结构化写 Word：标题、段落、表格、分页各是一个内容块。
async function structuredWord(outputPath = 'docs/spec.docx') {
  return createWord({
    outputPath,
    blocks: [
      { kind: 'heading', text: '设计说明', level: 1 },
      { kind: 'paragraph', text: '本节描述整体架构。' },
      { kind: 'table', header: true, rows: [[{ text: '字段' }, { text: '类型' }], [{ text: 'id' }, { text: 'string' }]] },
      { kind: 'pageBreak' },
    ],
    overwrite: true,
  })
}

// 给已有的 Word 接着写：appendMode 把新内容接在原文末尾。
async function appendToWord(outputPath = 'reports/weekly.docx') {
  return createWord({ outputPath, appendMode: true, content: '## 补充\n\n下周计划见附件。' })
}

// 做一份演示文稿：# 开新页，--- 分页，挑一个排版风格。
async function deck(outputPath = 'slides/review.pptx') {
  return createPresentation({
    outputPath,
    template: 'consulting',
    content: '# 季度回顾\n收入环比增长 12%\n---\n# 下季度计划\n- 拓展渠道 A\n- 上线会员体系',
    overwrite: true,
  })
}

// 结构化做表：表头样式、数字格式、冻结首行。
async function table(outputPath = 'data/sales.xlsx') {
  return createSpreadsheet({
    outputPath,
    sheets: [
      {
        name: '销售',
        columns: ['区域', '金额'],
        rows: [['华北', 1200], ['华南', 980]],
        headerStyle: { bold: true, bgColor: 'DDEBF7' },
        numberFormats: { 'B2:B3': '#,##0' },
        freezeRows: 1,
      },
    ],
    overwrite: true,
  })
}

// 读 PDF 的某几页；hasMore 为真说明还有没读的页。
async function readPages(inputPath = 'papers/paper.pdf') {
  const pdf = await readPdf({ inputPath, pages: [1, 2] })
  return { pageCount: pdf.pageCount, firstPage: pdf.pages[0]?.text.slice(0, 500), hasMore: pdf.hasMore }
}

// PDF 变 Word：读出文字，每页一节写进 Word。
async function pdfToWord(inputPath = 'papers/paper.pdf', outputPath = 'papers/paper.docx') {
  const pdf = await readPdf({ inputPath, maxPages: 50 })
  return createWord({
    outputPath,
    blocks: pdf.pages.flatMap((page) => [
      { kind: 'heading', text: `第 ${page.page} 页`, level: 2 },
      { kind: 'paragraph', text: page.text || '（这页没有可提取的文字）' },
    ]),
    overwrite: true,
  })
}

// Word 转 PDF：本机没装 LibreOffice 时抛 OFFICE_CONVERTER_MISSING，照 message 告诉用户。
async function exportPdf(inputPath = 'reports/weekly.docx') {
  try {
    return await wordToPdf({ inputPath, outputPath: 'reports/weekly.pdf', overwrite: true })
  } catch (error) {
    if (error.code === 'OFFICE_CONVERTER_MISSING') return { needsInstall: error.message }
    throw error
  }
}

// LaTeX 编成 PDF：编译失败时抛 OFFICE_CONVERSION_FAILED，message 里有编译日志的结尾，照着改源码再编。
async function compileLatex(outputPath = 'papers/formula.pdf') {
  const latexSource = '\\documentclass{article}\n\\begin{document}\nEnergy: $E = mc^2$\n\\end{document}\n'
  const compiled = await latexToPdf({ outputPath, latexSource, overwrite: true })
  return { pdf: compiled.path, tex: compiled.sourcePath, compiler: compiled.compiler }
}

// 编辑 PDF：挑前两页、第一页转 90 度、每页贴一行浅色水印（文字戳只写得了西文，写不了中文）。
async function excerptPdf(inputPath = 'papers/paper.pdf', outputPath = 'papers/excerpt.pdf') {
  return editPdf({
    inputPath,
    outputPath,
    pageSelection: [1, 2],
    rotatePages: [{ page: 1, degrees: 90 }],
    textStamps: [{ text: 'INTERNAL', allPages: true, opacity: 0.3 }],
    overwrite: true,
  })
}

// 生成之后检查一下：标题、计数、每页的标题。
async function check(inputPath = 'slides/review.pptx') {
  const result = await preview({ inputPath, maxItems: 10 })
  return { title: result.title, summary: result.summary, slides: result.slides?.map((slide) => slide.title) }
}

// 把文档转成 Markdown 来读；没装 MarkItDown 时 PDF 改用 readPdf。
async function asMarkdown(inputPath = 'docs/manual.pdf') {
  try {
    const converted = await toMarkdown({ inputPath, maxChars: 20000 })
    return { truncated: converted.truncated, head: converted.markdown.slice(0, 2000) }
  } catch (error) {
    if (error.code !== 'OFFICE_MARKITDOWN_UNAVAILABLE') throw error
    const pdf = await readPdf({ inputPath, maxPages: 5 })
    return { truncated: pdf.hasMore, head: pdf.pages.map((page) => page.text).join('\n').slice(0, 2000) }
  }
}
