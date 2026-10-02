// velaros:office 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 路径相对当前空间的工作区根；目标文件已经在时要传 overwrite: true 才覆盖。
import { createPresentation, createSpreadsheet, createWord, editPdf, latexToPdf, preview, readPdf, toMarkdown, wordToPdf } from 'velaros:office'

// 写报告后用真实文件做结构解析：生成回执与结构检查分别交付；解析成功只证明能读到这些结构，布局仍需查看预览。
async function report(outputPath = 'reports/weekly.docx') {
  const written = await createWord({
    outputPath,
    title: '周报',
    content: '# 本周进展\n\n- 完成登录改版\n- 推进支付接入\n\n| 指标 | 数值 |\n| --- | --- |\n| 日活 | 1200 |',
    overwrite: true,
  })
  return { written, structure: await check(written.path) }
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

// 结构化做表：原始行直接流入生成 API，再解析落盘文件；中间数据留在程序里，模型看产物与真实行列数。
async function table(outputPath = 'data/sales.xlsx') {
  return spreadsheetFromRows([['华北', 1200], ['华南', 980]], outputPath)
}

async function spreadsheetFromRows(rows = [['华北', 1200], ['华南', 980]], outputPath = 'data/sales.xlsx') {
  const written = await createSpreadsheet({
    outputPath,
    sheets: [
      {
        name: '销售',
        columns: ['区域', '金额'],
        rows,
        headerStyle: { bold: true, bgColor: 'DDEBF7' },
        numberFormats: { 'B2:B3': '#,##0' },
        freezeRows: 1,
      },
    ],
    overwrite: true,
  })
  return { written, structure: await check(written.path) }
}

// 读 PDF 的某几页；hasMore 为真说明还有没读的页。
async function readPages(inputPath = 'papers/paper.pdf') {
  const pdf = await readPdf({ inputPath, pages: [1, 2] })
  return { pageCount: pdf.pageCount, firstPage: pdf.pages[0]?.text.slice(0, 500), hasMore: pdf.hasMore }
}

// PDF 变 Word：读出文字，每页一节写进 Word。
async function pdfToWord(inputPath = 'papers/paper.pdf', outputPath = 'papers/paper.docx') {
  const pdf = await readPdf({ inputPath, maxPages: 50 })
  const written = await createWord({
    outputPath,
    blocks: pdf.pages.flatMap((page) => [
      { kind: 'heading', text: `第 ${page.page} 页`, level: 2 },
      { kind: 'paragraph', text: page.text || '（这页没有可提取的文字）' },
    ]),
    overwrite: true,
  })
  return { written, source: { path: inputPath, pageCount: pdf.pageCount, convertedPages: pdf.pages.map((page) => page.page), hasMore: pdf.hasMore }, structure: await check(written.path) }
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

// 读取实际产物：summary 是整份数量，outline/slides/sheets 只是 maxItems 范围的摘录，正文截断独立标记。
// 不给 outputPath 时 preview 不写盘；结构可解析不代表视觉布局或所有业务内容已验收。
async function check(inputPath = 'slides/review.pptx', maxItems = 10) {
  const result = await preview({ inputPath, maxItems })
  return { path: result.path, kind: result.kind, title: result.title, summary: result.summary,
    outline: result.outline, slides: result.slides, sheets: result.sheets, maxItems, contentTruncated: result.contentTruncated }
}

// 把文档转成 Markdown 来读；没装 MarkItDown 时 PDF 改用 readPdf。
async function asMarkdown(inputPath = 'docs/manual.pdf') {
  try {
    const converted = await toMarkdown({ inputPath, maxChars: 20000 })
    return { path: inputPath, truncated: converted.truncated || converted.markdown.length > 2000, head: converted.markdown.slice(0, 2000) }
  } catch (error) {
    if (error.code !== 'OFFICE_MARKITDOWN_UNAVAILABLE') throw error
    const pdf = await readPdf({ inputPath, maxPages: 5 })
    const text = pdf.pages.map((page) => page.text).join('\n')
    return { path: inputPath, pageCount: pdf.pageCount, selectedPages: pdf.pages.map((page) => page.page), truncated: pdf.hasMore || text.length > 2000, head: text.slice(0, 2000) }
  }
}
