/**
 * 使用已安装的 MarkItDown 插件转换文档，完整内容可按 outputPath 写入文件。
 */
declare module 'velaros:markitdown' {
  /** 用 MarkItDown 把 PDF、Office、HTML、CSV、JSON、EPub 这类文档转成 Markdown 来读（要装了 MarkItDown）。
   */
  export function toMarkdown(input: OfficeMarkdownInput): Promise<OfficeMarkdown>

  /**
   * 用 MarkItDown 把文档转成 Markdown：inputPath 是 .pdf、.doc、.docx、.ppt、.pptx、.xls、.xlsx、.html、.htm、.csv、.json、.xml、.zip、.epub、.txt、.md 或 .markdown，
   * 只认工作区里的文件、不收网址。maxChars 是交回多少字符（缺省 60000，1000 到 200000）；给 outputPath 就把完整 Markdown 写进去（没写扩展名补 .md），
   * 已在时要 overwrite: true。
   */
  interface OfficeMarkdownInput {
    inputPath: string
    maxChars?: number
    outputPath?: string
    overwrite?: boolean
  }

  /**
   * 转出的 Markdown：markdown 最多 maxChars 个字符，truncated 为真表示没交全。给了 outputPath 时交回的是开头，完整的文件照样写下（written）；
   * 没给时文档太长只拿得到结尾一段（markdown 第一行有注释说明）——要看全就给 outputPath，再按需读那个文件。
   */
  interface OfficeMarkdown {
    path: string
    markdown: string
    truncated: boolean
    written?: OfficeWritten
  }

  /** 写出的一个文件：path 是绝对路径，bytes 是字节数；created 为假表示覆盖（或追加）了已有的文件。 */
  interface OfficeWritten {
    path: string
    bytes: number
    created: boolean
  }
}
