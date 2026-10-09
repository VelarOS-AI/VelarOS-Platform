import { toMarkdown } from 'velaros:markitdown'

// 按需读取；长文档可传 outputPath 保存完整内容。
const result = await toMarkdown({ inputPath: 'document.pdf', maxChars: 10000 })
console.log(result)
