import { createWord, preview, readPdf, editPdf, createSpreadsheet, createPresentation } from 'velaros:office-documents'

// 生成后读取实际产物，核对结构与正文。
const word = await createWord({ outputPath: 'report.docx', title: '报告', content: '# 进展\n\n本期内容。' })
console.log(await preview({ inputPath: word.path }))
console.log(await readPdf({ inputPath: 'source.pdf', maxPages: 5 }))
console.log(await editPdf({ inputPath: 'source.pdf', outputPath: 'excerpt.pdf', pageSelection: [1] }))
console.log(await createSpreadsheet({ outputPath: 'data.xlsx', sheets: [{ name: '数据', rows: [['指标', '值'], ['数量', 10]] }] }))
console.log(await createPresentation({ outputPath: 'slides.pptx', content: '# 标题\n正文' }))
